import { moment as obsidianMoment } from "obsidian";

// Obsidian exposes moment.js, but its typings depend on the `moment` package
// being resolvable. This minimal local typing keeps lint and tsc independent of that.
type Unit = string;
type Input = number | string | Date | Moment | undefined;

export interface Moment {
  clone(): Moment;
  add(amount: number, unit: Unit): Moment;
  subtract(amount: number, unit: Unit): Moment;
  startOf(unit: Unit): Moment;
  endOf(unit: Unit): Moment;
  format(pattern?: string): string;
  fromNow(): string;
  valueOf(): number;
  isValid(): boolean;
  isSame(other?: Input, unit?: Unit): boolean;
  diff(other: Input, unit?: Unit): number;
  hour(): number;
  hour(value: number): Moment;
  minute(): number;
  minute(value: number): Moment;
  second(value: number): Moment;
  millisecond(value: number): Moment;
  date(): number;
  date(value: number): Moment;
  day(): number;
  day(value: number): Moment;
}

interface MomentFn {
  (input?: Input, format?: string | string[], strict?: boolean): Moment;
}

export const moment = obsidianMoment as unknown as MomentFn;
