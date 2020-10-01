// this module gives a limited scope to eval the pre/post function scope for workers
export const evalEnv = (x: string) => eval(x);