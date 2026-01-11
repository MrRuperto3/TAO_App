// src/lib/format.ts

// Many Subtensor values are returned in RAO-like units or as codec objects.
// This helper tries to normalize to something readable without needing to know
// every type ahead of time.

export function codecToString(x: any): string {
  if (x == null) return "0";

  // Most Polkadot codec values implement toHuman/toString
  try {
    if (typeof x.toHuman === "function") {
      const h = x.toHuman();
      if (typeof h === "string") return h;
      if (typeof h === "number") return String(h);
      // sometimes toHuman returns object/array
      return JSON.stringify(h);
    }
  } catch {}

  try {
    if (typeof x.toString === "function") return x.toString();
  } catch {}

  // Fallback
  return String(x);
}

export function tryParseBigInt(s: string): bigint | null {
  try {
    // If it's JSON like {"bits":"0x.."} we extract bits
    if (s.startsWith("{") && s.includes('"bits"')) {
      const obj = JSON.parse(s);
      const bits = obj?.bits;
      if (typeof bits === "string" && bits.startsWith("0x")) {
        return BigInt(bits);
      }
      if (typeof bits === "number") return BigInt(bits);
    }

    // If it's hex
    if (s.startsWith("0x")) return BigInt(s);

    // Plain integer string
    if (/^-?\d+$/.test(s)) return BigInt(s);

    return null;
  } catch {
    return null;
  }
}

export function formatInt(s: string): string {
  const bi = tryParseBigInt(s);
  if (bi === null) return s;
  const neg = bi < 0n;
  const abs = neg ? -bi : bi;
  const withCommas = abs.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return neg ? `-${withCommas}` : withCommas;
}

// Optional: show a smaller “compact” view (e.g., 12.3M, 4.5B)
export function formatCompact(s: string): string {
  const bi = tryParseBigInt(s);
  if (bi === null) return s;
  const neg = bi < 0n;
  const abs = Number(neg ? -bi : bi);

  if (!Number.isFinite(abs)) return formatInt(s);

  const units = [
    { v: 1e12, suf: "T" },
    { v: 1e9, suf: "B" },
    { v: 1e6, suf: "M" },
    { v: 1e3, suf: "K" },
  ];

  for (const u of units) {
    if (abs >= u.v) {
      const val = (abs / u.v).toFixed(2).replace(/\.?0+$/, "");
      return `${neg ? "-" : ""}${val}${u.suf}`;
    }
  }

  return `${neg ? "-" : ""}${abs.toFixed(0)}`;
}
