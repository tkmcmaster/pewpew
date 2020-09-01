import { BodyBuffer, Header, HeaderBuffer } from "./src/message.ts";
import { receiveOp as performScriptingOp } from "./src/ops.ts";
import { decodeIncomingMessages } from "./src/byteUtils.ts";
import { receiveOp } from "./src/ops.ts";

type JsonTypeValue<T> = { [key: string]: string | number | null | T };
export interface JsonType extends JsonTypeValue<JsonType> {};

for await (const [header, body] of decodeIncomingMessages(Deno.stdin)) {
  receiveOp(header, body);
}