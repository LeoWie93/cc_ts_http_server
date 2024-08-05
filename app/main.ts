import * as net from 'node:net';
import { parseArgs } from "node:util";
import fs from 'fs';
import zlib from 'node:zlib';

const CRLF: string = "\r\n";
let RELATIVE_ROOT: string;

type Header = {
    name: string;
    value: string;
}

class HttpResponse {
    protocol: string;
    statusCode: number;
    status: string;
    headers: Map<string, Header> = new Map<string, Header>;
    body: Buffer = Buffer.from("");

    constructor() {
        this.protocol = "HTTP/1.1";
        this.statusCode = 200;
        this.status = "OK";
    }

    getHeaderString(): string {
        let headerString: string = "";
        this.headers.forEach(header => {
            headerString += header.name + ": " + header.value + `\r\n`
        });

        return headerString;
    }

    getHeaders(): Map<string, Header> {
        return this.headers;
    }

    setHeaders(headers: Map<string, Header>): void {
        this.headers = headers;
    }

    removeHeader(key: string): boolean {
        return this.headers.delete(key);
    }

    setHeader(key: string, value: string): void {
        this.headers.set(key, { name: key, value: value } as Header);
    }

    setContentType(value: string): void {
        this.setHeader("Content-Type", value);
    }

    setContentLength(value: number): void {
        this.setHeader("Content-Length", value.toString());
    }

    setContentEncoding(value: string): void {
        this.setHeader("Content-Encoding", value);
    }

    setBody(body: Buffer): void {
        this.body = body;
    }

    getBody(): Buffer {
        return this.body;
    }
}

const server = net.createServer((socket) => {
    // socket = socket.setKeepAlive(false)

    socket.on('end', function() {
        // cleanup?
        // this is js and we have a gc. so no / maybe look into it to be certaint
        console.log('disconnected');
        console.log("-------------")
    });

    const response: HttpResponse = new HttpResponse()

    socket.on('data', function(data: Buffer) {
        let requestString: string = data.toString('utf8')
        console.log(requestString);

        //parsing of request string (general function)
        // requestLine
        const requestLine: string = requestString.split(CRLF, 1)[0];
        requestString = requestString.replace(requestLine, "")

        // headers
        const headerString: string = requestString.split(CRLF + CRLF, 1)[0]
        requestString = requestString.replace(headerString, "")

        const headers: Map<string, string> = new Map<string, string>;
        headerString.split("\r\n").forEach(headerLine => {
            //could be removed if the initial requestString parsing changes
            if (headerLine === '') {
                return;
            }

            headerLine = headerLine.replace(CRLF, "");
            const headerParts: Array<string> = headerLine.split(":");

            headers.set(headerParts[0], headerParts[1].trim())
        })

        // body
        const body: string = requestString.trim();

        const [method, path, version]: string = requestLine.split(" ")
        const parts: Array<string> = path.split("/").filter(part => part != "")

        // just use pattern matchin => not tyescript native...
        if (parts[0] === "echo" && parts[1] !== undefined) {
            response.setBody(Buffer.from(parts[1]));
            response.setContentType("text/plain");
            response.setContentLength(parts[1].length);
        } else if (parts[0] === "files" && parts[1] !== undefined) {
            if (method === "GET") {
                try {
                    const fileContent: string = fs.readFileSync(RELATIVE_ROOT + '/' + parts[1], 'utf8');

                    response.setBody(Buffer.from(fileContent));
                    response.setContentType("application/octet-stream");
                    response.setContentLength(fileContent.length);
                } catch (error) {
                    response.statusCode = 404;
                    response.status = "Not Found";
                }
            } else if (method === "POST") {
                // check for content type?
                const headerLength: string | undefined = headers.get("Content-Length");
                if (!headerLength || headerLength && body.length !== parseInt(headerLength)) {
                    console.error(headerLength);
                    console.error(body);
                    console.error(body.length);
                    throw new Error("header length and body missmatch");
                }

                //TODO handle exception..
                fs.writeFileSync(RELATIVE_ROOT + '/' + parts[1], body);
                response.statusCode = 201;
                response.status = "Created";
            }
        } else if (parts[0] === "user-agent") {
            const userAgent: string | undefined = headers.get("User-Agent");
            if (!userAgent) {
                throw new Error("header not defined")
            }

            response.setBody(Buffer.from(userAgent));
            response.setContentType("text/plain");
            response.setContentLength(userAgent.length);
        } else if (parts.length === 0) {
            //do nothing
            // "/" route
        } else {
            response.statusCode = 404;
            response.status = "Not Found";
        }


        // handle special headers
        const encodedResponse: HttpResponse = handleEncodingHeader(response, headers);

        socket.write(`${encodedResponse.protocol} ${encodedResponse.statusCode} ${encodedResponse.status}${CRLF}${encodedResponse.getHeaderString()}${CRLF}`, function(error): void {
            console.log("finished writing response line and headers.");
            if (error) {
                console.log(error);
            }
        });

        socket.write(encodedResponse.getBody(), function(error): void {
            console.log("finished writing body");
            if (error) {
                console.log(error);
            }
        });

        socket.end();
    });
});

server.listen(4221, 'localhost', () => {

    // preparations before server startup
    const { values, positionals } = parseArgs({
        args: process.argv,
        options: {
            directory: {
                type: 'string',
                short: 'd',
            },
        },
        strict: true,
        allowPositionals: true,
    });

    RELATIVE_ROOT = values['directory'] !== undefined && values['directory'] || "./";
    console.debug('using directory:', RELATIVE_ROOT);

    console.log('Server is running on port 4221');
});

// make a map with each class declaration to use
const supportedEncodings: Map<string, Function> = new Map<string, Function>([
    ['gzip', zlib.gzipSync]
]);

// methods
function handleEncodingHeader(response: HttpResponse, headers: Map<string, string>): HttpResponse {
    if (!headers.has('Accept-Encoding')) {
        return response;
    }

    const body: Buffer = response.getBody();
    response.setBody(Buffer.from(""));

    response.setContentType('text/plain');
    response.removeHeader('Content-Length');

    const encodingString: string | undefined = headers.get('Accept-Encoding');
    const encoding = encodingString?.replace(/\s/g, "").split(",").find(function(param) {
        return supportedEncodings.has(param);
    });

    //is their a better typescript way?
    if (encoding !== undefined && supportedEncodings.has(encoding)) {
        const encodingFunction: Function | undefined = supportedEncodings.get(encoding);
        if (encodingFunction !== undefined) {
            const encodedBody: Buffer = zlib.gzipSync(body);

            response.setContentLength(encodedBody.length);
            response.setBody(encodedBody);

            response.setContentEncoding(encoding);
        }
    }

    return response;
}

