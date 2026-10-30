/** Give `target` its own `name` property until the returned function puts back what it had. */
export function swapProperty(target: object, name: string, value: unknown): () => void {
  const own = Object.getOwnPropertyDescriptor(target, name);
  Object.defineProperty(target, name, { configurable: true, writable: true, value });
  return () => {
    if (own === undefined) {
      Reflect.deleteProperty(target, name);
    } else {
      Object.defineProperty(target, name, own);
    }
  };
}

/** Call a method found by name, such as one of pi's private ones, and return what it gives back, unchecked. */
export function callMethod(method: unknown, self: unknown, args: readonly unknown[]): unknown {
  return typeof method === "function" ? Reflect.apply(method, self, args) : undefined;
}

/** Run every function in `restores`, last first. */
export function restoreAll(restores: readonly (() => void)[]): void {
  for (const restore of restores.toReversed()) {
    restore();
  }
}

export const isStringArray = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === "string");
