// this module gives a scope for functions which need to be eval'd

import { JsonType } from "../pewpew.ts";
import { getProviderValue, addProviderValue, logMessage } from "./ops.ts";

const providers = {
  get(name: string): Promise<JsonType> {
    return getProviderValue(name);
  },
  set(name: string, value: JsonType): Promise<void> {
    return addProviderValue(name, value);
  }
};

function log(name: string, message: JsonType): Promise<void> {
  return logMessage(name, message);
}

export const evil = (x: string) => eval(x);