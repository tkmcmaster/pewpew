import { decodeIncomingMessages } from "./src/byteUtils.ts";
import { receiveOp } from "./src/ops.ts";

for await (const [header, body] of decodeIncomingMessages(Deno.stdin)) {
  receiveOp(header, body);
}