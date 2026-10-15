import { AsyncLocalStorage } from "node:async_hooks";
import { statSync } from "node:fs";
import { resolve } from "node:path";

/** Async-local execution directory. Scopes nest, overlap without interference, and never call process.chdir(). */
export class ExecutionDirectory {
	private readonly storage = new AsyncLocalStorage<string>();
	private readonly active: string[] = [];
	private readonly baseCwd: string;
	private readonly onChange: () => void;

	constructor(cwd: string, onChange: () => void = () => {}) {
		this.baseCwd = cwd;
		this.onChange = onChange;
	}

	get cwd(): string {
		return this.storage.getStore() ?? this.baseCwd;
	}

	get isScoped(): boolean {
		return this.storage.getStore() !== undefined;
	}

	get activeDirectories(): readonly string[] {
		return [...new Set(this.active)];
	}

	async run<T>(directory: string, callback: () => Promise<T>): Promise<T> {
		const cwd = resolve(this.cwd, directory);
		if (!statSync(cwd).isDirectory()) throw new Error(`Execution directory is not a directory: ${cwd}`);
		this.active.push(cwd);
		this.onChange();
		try {
			return await this.storage.run(cwd, callback);
		} finally {
			this.active.splice(this.active.indexOf(cwd), 1);
			this.onChange();
		}
	}
}
