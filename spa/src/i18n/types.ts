import type { zh } from "./zh";

export type Locale = "zh" | "en";

/** The message tree with every leaf widened to string (zh.ts is the key source). */
export type Shape<T> = { [K in keyof T]: T[K] extends string ? string : Shape<T[K]> };
export type Messages = Shape<typeof zh>;

type Leaves<T, P extends string = ""> = {
  [K in keyof T & string]: T[K] extends string ? `${P}${K}` : Leaves<T[K], `${P}${K}.`>;
}[keyof T & string];

/** Every message key, "namespace.key". */
export type MessageKey = Leaves<Messages>;
export type Vars = Record<string, string | number>;
export type TFunction = (key: MessageKey, vars?: Vars) => string;
