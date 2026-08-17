import { createInterface } from 'node:readline/promises';

export interface ReviewPrompter {
  ask(prompt: string): Promise<string>;
}

export function createReviewPrompter(output: NodeJS.WritableStream): ReviewPrompter {
  return {
    async ask(prompt: string): Promise<string> {
      const readline = createInterface({ input: process.stdin, output });
      try {
        return await readline.question(prompt);
      } finally {
        readline.close();
      }
    },
  };
}
