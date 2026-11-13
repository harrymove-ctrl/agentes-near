import { useEffect, useState } from "react";

/**
 * The time now, moving on every `every` ms (a countdown, the minutes a request has left); `false`: still. A
 * function picks the pace from the time it last read (a countdown repaints faster near its end).
 */
export function useNow(every: number | false | ((now: number) => number | false)) {
  const [now, setNow] = useState(() => Date.now());
  const ms = typeof every === "function" ? every(now) : every;
  useEffect(() => {
    if (ms === false) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}
