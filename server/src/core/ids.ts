import { uuidv7 } from "uuidv7";

export type Uuid = string;

export function newId(): Uuid {
  return uuidv7();
}
