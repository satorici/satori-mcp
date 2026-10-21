/**
 * Python's shlex.split (POSIX mode, no comments): whitespace splits, quotes group, backslash
 * escapes. Shell operators such as `|` or `;` are ordinary characters, as in Python.
 */
export function shlexSplit(command: string): string[] {
  const tokens: string[] = [];
  let token = "";
  let inToken = false;
  let quote: "'" | '"' | null = null;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote === "'") {
      if (ch === "'") quote = null;
      else token += ch;
    } else if (quote === '"') {
      if (ch === '"') quote = null;
      else if (ch === "\\" && i + 1 < command.length && (command[i + 1] === '"' || command[i + 1] === "\\")) {
        token += command[++i];
      } else token += ch;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      inToken = true;
    } else if (ch === "\\") {
      if (i + 1 >= command.length) throw new Error("No escaped character");
      token += command[++i];
      inToken = true;
    } else if (/\s/.test(ch)) {
      if (inToken) tokens.push(token);
      token = "";
      inToken = false;
    } else {
      token += ch;
      inToken = true;
    }
  }
  if (quote) throw new Error("No closing quotation");
  if (inToken) tokens.push(token);
  return tokens;
}
