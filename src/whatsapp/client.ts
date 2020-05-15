import WebSocket from "ws";
import { randomBytes, createHmac } from "crypto";
import { arch, platform } from "os";
import { CmdInitResponse, WhatsAppCmdType, WhatsAppCmdAction, WhatsAppServerMsg, WhatsAppServerMsgConn, WhatsAppServerMsgCmd, WhatsAppServerMsgCmdChallenge, WhatsAppClientConfig } from "./interfaces";
import * as fs from 'fs'
import { configLoad, configStore } from "../utils";
import { generateKeyPair, decryptEncryptionKeys, AESDecrypt, AESEncrypt } from "./secure";
import { EventEmitter } from "events";
import authRestoreTakeOver from "./auth/restore-takeover";

export default class Client {
    /** This app name */
    clientName = 'WaJs'

    /** Compactible Web WhatsApp Version */
    version = '2.2019.6'

    /** Proto version when this created */
    protoVersion = [0, 17]

    /** Binary protocol version */
    binVersion = 10

    /** Stored Session info */
    config: WhatsAppClientConfig

    /** Collected server command data */
    serverData: {
        [key: string]: any
        Conn?: WhatsAppServerMsgConn
    } = {};

    ws: WebSocket
    timeSkew: number

    private messageConter: number = 0
    private startTime: string;
    private cmdStack = new Map<String, { message: String | Buffer, resolve: Function, reject: Function }>()
    protected onReady: (info: WhatsAppServerMsgConn, err?: string) => void

    constructor(private authFile = '.auth', private event: EventEmitter) {
        if (fs.existsSync(authFile)) {
            this.config = configLoad(this.authFile)
        } else {
            // default config
            this.config = {
                clientId: randomBytes(16).toString('base64'),
                keys: generateKeyPair()
            }
        }
    }

    connect() {
        return new Promise<WhatsAppServerMsgConn>(
            (resolve, reject) => {
                this.startTime = new Date().getTime().toString(36)
                this.ws = new WebSocket("wss://web.whatsapp.com/ws", {
                    origin: "https://web.whatsapp.com",
                })
                const onOpen = () => {
                    // Swap error listener
                    this.ws.removeListener("error", reject)
                    this.ws.on('error', this.onError)
                    // INIT
                    this.sendCmd<CmdInitResponse>('admin', 'init',
                        this.version.split('.').map(v => parseInt(v)),
                        [this.clientName, platform(), arch()],
                        this.config.clientId,
                        true
                    ).then(response => {
                        if (response.status != 200) {
                            L(response)
                            reject('Init error: ' + response.status)
                        } else if (!response || !response.ref) {
                            L(response)
                            reject('No server id')
                        } else {
                            const ttl = response.ttl || 20000
                            const qrCodeLogin = () => require('./auth/login-qrcode').default.call(this, response.ref, ttl)
                            // Has stored session? restore it.
                            return this.config.tokens ?
                                authRestoreTakeOver.call(this, response.ref, ttl)
                                    .catch(err => {
                                        E('loginRestore:', err)
                                        if (fs.existsSync(this.authFile)) {
                                            L('Deleting expired config');
                                            fs.unlinkSync(this.authFile)
                                        }
                                        return qrCodeLogin()
                                    }) :
                                qrCodeLogin()
                        }
                    }).then(resolve).catch(reject)
                }

                // Fail on early error
                this.ws.once("error", reject)
                this.ws.once("open", onOpen)
                this.ws.on("message", this.onMessage)
                this.ws.on("close", this.onClose)
            }
        )
    }

    private handleWhatsAppConn(info: WhatsAppServerMsgConn) {
        if (!this.onReady) {
            return L('Got Conn but no handler, ignore it', info)
        }
        // On restored session is not contain secret
        if (info.secret) {
            L('handleWhatsAppConn: decrypt secret');
            this.config.serverSecret = Buffer.from(info.secret, 'base64');
            const result = decryptEncryptionKeys(this.config.serverSecret, this.config.keys.privateKey)
            this.config.aesKey = result.aesKey
            this.config.macKey = result.macKey
        } else {
            L('handleWhatsAppConn: no secret, its resumed.');
        }

        if (!this.config.aesKey) {
            return this.onReady(null, 'No Encryptions Keys!')
        }
        this.config.tokens = {
            client: info.clientToken,
            server: info.serverToken,
            browser: info.browserToken
        }
        // Save creds
        configStore(this.authFile, this.config)

        // call on ready
        this.onReady(info);
    }

    private onMessage = (data: string | Buffer) => {
        const firstCommaPos = data.indexOf(',');
        const tag = data.slice(0, firstCommaPos).toString('ascii')
        const message: string | Buffer = data.slice(firstCommaPos + 1)
        if (typeof message == 'string') {
            switch (tag[0]) {
                case '!':
                    let ts = parseInt(tag.slice(1))
                    this.timeSkew = Date.now() - ts
                    break;
                case 's':
                    //server message
                    const params: any[] = JSON.parse(message);
                    this.handleServerMessage(params.shift() as any, params);
                    break;

                default:
                    if (this.cmdStack.has(tag)) {
                        const handle = this.cmdStack.get(tag)
                        this.cmdStack.delete(tag)
                        const param = message ? JSON.parse(message) : null
                        handle.resolve(param)
                    } else {
                        L('Unhandled CMD Response', tag, message)
                    }
                    break;
            }
        } else {
            this.decrypt(message)
        }
    }

    private decrypt(data: Buffer) {
        if (!this.config.aesKey) {
            throw new Error("GotBuffer but no key to decrypt")
        }
        if (!this.config.macKey) {
            throw new Error("no hmac key to verify")
        }
        const hmac = createHmac('sha256', this.config.macKey).update(data.slice(32)).digest()
        const hmacServer = data.slice(0, 32)
        if (hmac.compare(hmacServer) !== 0) {
            L('HMAC gen', hmac)
            L('HMAC srv', hmacServer)
            L('HMAC ===', hmac.compare(hmacServer))
            throw new Error('Hmac Miss Match');
        }
        return AESDecrypt(this.config.aesKey, data.slice(32, 32 + 16), data.slice(32 + 16))
    }
    /** 32 byte HMAC + Buffer */
    private encrypt(data: Buffer) {
        // Encrypt first, then sign
        data = AESEncrypt(this.config.aesKey, data)
        const hmac = createHmac('sha256', this.config.macKey).update(data).digest()
        return Buffer.concat([hmac, data])
    }

    private onClose = (code: Number, message: String) => {
        L("CLOSED!", code, message);
    }
    private onError = (error: Error) => {
        console.error("ERR!", error);
    }
    send<T = any>(message: Buffer | string) {
        return new Promise<T>(
            (resolve, reject) => {
                const tag = `${this.startTime}.${this.messageConter++}`
                if (typeof message == 'string') {
                    message = `${tag},${message}`
                } else {
                    // encrypted
                    message = Buffer.concat([Buffer.from(`${tag},`, 'ascii'), message])
                }
                this.cmdStack.set(tag, { message, resolve, reject })
                this.ws.send(message)
            }
        )
    }

    sendCmd<T = any>(scope: WhatsAppCmdType, cmd: WhatsAppCmdAction, ...args: Array<string | boolean | any[]>) {
        return this.send<T>(JSON.stringify(
            [scope, cmd, ...args]
        ))
    }
    sendBin<T = any>(cmd: string, attr: any, data?: any) {
        const message = this.encrypt(Buffer.from(JSON.stringify([cmd, attr, data]), 'ascii'))
        return this.send(message)
    }
    private handleServerMessage(cmd: WhatsAppServerMsg, params: any[]) {
        switch (cmd) {
            case 'Stream':
                // Ignore
                return;
            case 'Cmd':
                const args = params[0] as WhatsAppServerMsgCmd
                this.event.emit(args.type || 'cmd', ...params)
                if (this.serverCmdHandlers[args.type]) {
                    this.serverCmdHandlers[args.type](args)
                } else {
                    L('handleServerMessage: unhandled cmd.', cmd, args)
                }
                break;
            case 'Conn':
                this.serverData[cmd] = params[0]
                this.handleWhatsAppConn(params[0])
                break;
            default:
                this.serverData[cmd] = params[0]
                L('handleServerMessage: ignored', cmd, params.constructor.name)
                break;
        }
    }
    /** Internal command handler */
    private serverCmdHandlers = {
        disconnect: (args) => {
            if (args.kind == 'replaced') {
                this.event.emit('replaced')
            }
        },
        challenge: (args: WhatsAppServerMsgCmdChallenge) => {
            L('Handling challenge');
            const signed = this.sign(Buffer.from(args.challenge, 'base64'))
            return this.sendCmd('admin', 'challenge',
                signed.toString('base64'),
                this.config.tokens.server,
                this.config.clientId)
                .then(
                    res => L('Chalenge response', res)
                )
        }
    }
    sign(data: Buffer) {
        const sign = createHmac('sha256', this.config.macKey).update(data).digest()
        return Buffer.concat([sign, data])
    }
    close() {
        if (this.ws && this.ws.readyState == this.ws.OPEN) {
            this.ws.close()
        }
    }
}
