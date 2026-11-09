// Turns Tectonic / LaTeX output into structured errors, warnings and bad boxes.

export type IssueType = 'error' | 'warning' | 'badbox';

export interface Issue {
  type: IssueType;
  /** As printed by the compiler, normally relative to the main file's folder. */
  file: string;
  line: number;
  message: string;
}

const STANDARD = /^(warning|error):\s+([^:]+):(\d+):\s*(.*)$/i;
const OVERFULL = /^warning:\s+([^:]+):(\d+):\s*(Overfull \\hbox.*)$/i;
const UNDERFULL = /^warning:\s+([^:]+):(\d+):\s*(Underfull \\hbox.*)$/i;
const TEX_ERROR = /^!\s+(.*?)$/;
const LINE_NUMBER = /^l\.(\d+)\s+(.*?)$/;
const LINE_BREAKS = /\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/;

const ENGINE_FAILURE = /^(something bad happened inside XeTeX|the XeTeX engine had an unrecoverable error|halted on potentially-recoverable error)/i;

const MAIN = 'main.tex';

function slashes(file: string): string {
  return file.replace(/\\/g, '/');
}

/** `mainFile` names the fallback location, for messages that do not say where they come from. */
export function parseCompilerIssues(log: string, mainFile: string = MAIN): Issue[] {
  const issues: Issue[] = [];
  const lines = log.split(LINE_BREAKS);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const box = OVERFULL.exec(line) ?? UNDERFULL.exec(line);
    if (box) {
      issues.push({ type: 'badbox', file: slashes(box[1]), line: Number(box[2]), message: box[3].trim() });
      continue;
    }

    const standard = STANDARD.exec(line);
    if (standard) {
      issues.push({
        type: standard[1].toLowerCase() as IssueType,
        file: slashes(standard[2]),
        line: Number(standard[3]),
        message: standard[4].trim(),
      });
      continue;
    }

    const texError = TEX_ERROR.exec(line);
    if (texError) {
      let lineNumber = 1;
      for (let j = i + 1; j < Math.min(i + 6, lines.length); j++) {
        const m = LINE_NUMBER.exec(lines[j].trim());
        if (m) {
          lineNumber = Number(m[1]);
          break;
        }
      }
      // Tectonic prints each error located, then repeats TeX's own transcript of it.
      const text = texError[1].replace(/\.$/, '');
      if (!issues.some((issue) => issue.type === 'error' && issue.line === lineNumber && issue.message.replace(/\.$/, '') === text)) {
        issues.push({ type: 'error', file: mainFile, line: lineNumber, message: texError[1] });
      }
      continue;
    }

    const lower = line.toLowerCase();
    if (lower.includes('overfull \\hbox') || lower.includes('underfull \\hbox')) {
      issues.push({ type: 'badbox', file: mainFile, line: 1, message: line });
    } else if (line.startsWith('error:')) {
      issues.push({ type: 'error', file: mainFile, line: 1, message: line.slice(6).trim() });
    }
  }

  // "The engine failed" adds nothing once the actual error is known.
  const specific = issues.filter((issue) => issue.type === 'error' && !ENGINE_FAILURE.test(issue.message));
  return specific.length ? issues.filter((issue) => !(issue.type === 'error' && ENGINE_FAILURE.test(issue.message))) : issues;
}
