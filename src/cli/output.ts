export interface OutputOptions {
  json: boolean;
  stdout: NodeJS.WriteStream;
}

export function writeResult(value: unknown, options: OutputOptions): void {
  const output = options.json
    ? JSON.stringify(value)
    : typeof value === 'string'
      ? value
      : JSON.stringify(value, null, 2);

  options.stdout.write(`${output}\n`);
}
