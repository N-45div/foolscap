/**
 * A fake one-shot agent in the shape of `oz agent run --prompt …
 * --output-format json`: reads its flags, prints one JSON document,
 * exits. "fail" in the prompt exits non-zero; "plain" prints text only.
 */
const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i > -1 ? args[i + 1] : undefined;
};
const prompt = flag("--prompt") ?? "";
const cwd = flag("--cwd") ?? process.cwd();

if (prompt.includes("plain")) {
  process.stdout.write(`Plain text answer for: ${prompt}\n`);
  process.exit(0);
}
if (prompt.includes("fail")) {
  process.stderr.write("agent error: could not reach the model\n");
  process.stdout.write(JSON.stringify({ status: "error", output: "" }) + "\n");
  process.exit(2);
}
process.stdout.write(
  JSON.stringify({
    run_id: "run_123",
    status: "completed",
    output: `Summarised ${cwd}: 3 packages, tests green.`,
    tokens: { output: 42 },
  }) + "\n",
);
