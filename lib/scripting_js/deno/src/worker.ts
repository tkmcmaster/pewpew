/// <reference lib="webworker"/>

import type { JsonType } from "../pewpew.ts";
import type { AddProviderValueOptions } from "./byteUtils.ts";

let preFunctions: Array<(providers: Providers) => Promise<JsonType | undefined>>;
let postFunctions: Array<(providers: Providers) => Promise<JsonType | undefined>>;

const ops = [
  createEnv,
  callPreFunction,
  callPostFunction,
];

interface PostFunctionData {
  request: JsonType,
  response: JsonType,
  fnId: number,
}

interface Providers {
  get(s: string): Promise<JsonType>;
  set(s: string, value: JsonType, options?: AddProviderValueOptions): Promise<void>;
}


onmessage = (e) => {
  const [opCode, data, end] = e.data;
  const fn = ops[opCode];
  ops[opCode](data);
};


function createEnv(code: string) {

}

function callPreFunction(n: number) {

}

function callPostFunction(n: number) {

}