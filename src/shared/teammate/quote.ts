/** One word for a POSIX shell: single quotes keep every character as it is, and a ' closes them for an escaped one. */
export const posixQuote = (v: string): string => `'${v.replace(/'/g, '\'\\\'\'')}'`;

// A TOML basic string is a JSON string for everything a path or an id can hold.
export const tomlString = (v: string): string => JSON.stringify(v);

/** A TOML key: bare when it can be, else quoted. */
export const tomlKey = (k: string): string => (/^[A-Za-z0-9_-]+$/.test(k) ? k : tomlString(k));
