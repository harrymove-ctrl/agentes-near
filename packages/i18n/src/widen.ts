/** A locale's shape: the source's keys with every string widened (other locales are typed against it). */
export type Widen<T> = { [K in keyof T]: T[K] extends string ? string : Widen<T[K]> };
