import { AsyncLocalStorage } from "node:async_hooks";
import { statSync } from "node:fs";
import { resolve } from "node:path";

export class ExecutionDirectoryBusyError extends Error {
	constructor(message = "Cannot replace or reload the session while execution directory scopes are active") {
		super(message);
		this.name = "ExecutionDirectoryBusyError";
	}
}

interface DirectoryScope {
	cwd: string;
	active: boolean;
	parent?: DirectoryScope;
	pending: Set<Promise<void>>;
}

export class ExecutionDirectory {
	private readonly storage = new AsyncLocalStorage<DirectoryScope>();
	private readonly scopes = new Set<DirectoryScope>();
	private readonly baseCwd: string;
	private readonly onChange: () => void;
	private disposed = false;
	private suspended = false;

	constructor(cwd: string, onChange: () => void = () => {}) {
		this.baseCwd = cwd;
		this.onChange = onChange;
	}

	get cwd(): string {
		this.assertActive();
		return this.storage.getStore()?.cwd ?? this.baseCwd;
	}

	get activeDirectories(): readonly string[] {
		return [...new Set([...this.scopes].map((scope) => scope.cwd))];
	}

	get isScoped(): boolean {
		return this.storage.getStore() !== undefined;
	}

	assertActive(): void {
		if (this.disposed) throw new Error("Execution directory belongs to a disposed session");
		for (let scope = this.storage.getStore(); scope; scope = scope.parent) {
			if (!scope.active) throw new Error("Execution directory scope has ended; await all work inside its callback");
		}
	}

	track(promise: Promise<void>): void {
		const scope = this.storage.getStore();
		if (!scope) return;
		const settled = promise.then(
			() => {},
			() => {},
		);
		scope.pending.add(settled);
		void settled.then(() => scope.pending.delete(settled));
	}

	suspend(): () => void {
		this.assertActive();
		if (this.scopes.size > 0 || this.suspended) {
			throw new ExecutionDirectoryBusyError();
		}
		this.suspended = true;
		return () => {
			this.suspended = false;
		};
	}

	outsideScope<T>(callback: () => T): T {
		return this.storage.exit(callback);
	}

	async run<T>(directory: string, callback: () => Promise<T>): Promise<T> {
		if (this.suspended)
			throw new ExecutionDirectoryBusyError(
				"Cannot enter an execution directory during session replacement or reload",
			);
		const cwd = resolve(this.cwd, directory);
		if (!statSync(cwd).isDirectory()) throw new Error(`Execution directory is not a directory: ${cwd}`);
		const scope: DirectoryScope = { cwd, active: true, parent: this.storage.getStore(), pending: new Set() };
		this.scopes.add(scope);
		try {
			this.onChange();
			return await this.storage.run(scope, callback);
		} finally {
			while (scope.pending.size > 0) await Promise.all(scope.pending);
			scope.active = false;
			this.scopes.delete(scope);
			if (!this.disposed) this.onChange();
		}
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		for (const scope of this.scopes) scope.active = false;
		this.scopes.clear();
		this.onChange();
	}
}
