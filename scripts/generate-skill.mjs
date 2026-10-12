import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import ts from "typescript";

const source = await readFile("src/schema.ts", "utf8");
const javascript = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { commands, ERROR_DEFINITIONS } = await import(`data:text/javascript;base64,${Buffer.from(javascript).toString("base64")}`);
const { version } = JSON.parse(await readFile("package.json", "utf8"));
const prose = (await readFile("skill/prose.md", "utf8")).trimEnd();
const index = commands.map(({ command, summary, flags }) => {
  const required = flags.filter(({ required }) => required).map(({ name }) => `--${name}`).join(", ") || "none";
  return `| \`cheqi ${command.join(" ")}\` | ${summary.replaceAll("|", "\\|")} | ${required} |`;
}).join("\n");
const errors = ERROR_DEFINITIONS.map(({ code, retryable, exitCode, meaning }) =>
  `| \`${code}\` | ${retryable ? "yes" : "no"} | ${exitCode} | ${meaning} |`).join("\n");
const output = `---\nname: cheqi\ndescription: Use when issuing or validating Cheqi digital receipts from a shell.\ncli-version: ${version}\n---\n\n${prose}\n\n## Command index\n\n| Command | Summary | Required flags |\n| --- | --- | --- |\n${index}\n\nRun \`cheqi schema <command>\` for full flag descriptions and response details.\n\n## Error codes\n\n| Code | Retryable | Exit | Meaning |\n| --- | --- | ---: | --- |\n${errors}\n`;
const target = resolve("skill/cheqi/SKILL.md");
await mkdir(resolve("skill/cheqi"), { recursive: true });
await writeFile(target, output);
