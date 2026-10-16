import http from "node:http";
import {Readable} from "node:stream";
import {handleRequest,parseAllowedOrigins} from "./handler.js";

const args = process.argv.slice(2);
const port = args.length === 0 ? 8787 : args.length === 2 && args[0] === "--port" ? Number(args[1]) : NaN;
if (!Number.isInteger(port) || port < 1 || port > 65535) { console.error("Usage: node relay/serve.mjs [--port 8787]"); process.exit(1); }
let allowedOrigins;
try { allowedOrigins = parseAllowedOrigins(process.env.NZT_RELAY_ALLOWED_ORIGINS); }
catch { console.error("NZT_RELAY_ALLOWED_ORIGINS must contain explicit comma-separated origins."); process.exit(1); }

const server = http.createServer(async (incoming,outgoing) => {
  try {
    // The listener is fixed to loopback; never derive an upstream from Host or URL.
    const url = new URL(incoming.url,`http://127.0.0.1:${port}`);
    const options = {method:incoming.method,headers:incoming.headers};
    if (!["GET","HEAD"].includes(incoming.method)) { options.body = Readable.toWeb(incoming); options.duplex = "half"; }
    const response = await handleRequest(new Request(url,options),{allowedOrigins});
    outgoing.writeHead(response.status,Object.fromEntries(response.headers));
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  } catch {
    if (!outgoing.headersSent) outgoing.writeHead(500,{"Content-Type":"application/json","Cache-Control":"no-store"});
    outgoing.end(JSON.stringify({error:{code:"relay_error",message:"The local relay could not complete the request."}}));
  }
});
server.requestTimeout = 30000;
server.headersTimeout = 15000;
server.on("error",()=>{console.error("The local relay could not start. Check that its port is available.");process.exitCode=1;});
server.listen(port,"127.0.0.1",()=>console.log(`NZT-49 Tinker relay: http://127.0.0.1:${port}`));
