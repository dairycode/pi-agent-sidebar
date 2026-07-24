export class AsyncQueue {
	private tail: Promise<void> = Promise.resolve();

	public enqueue<T>(operation: () => Promise<T>): Promise<T> {
		const run = this.tail.then(operation, operation);
		this.tail = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	public async drain(): Promise<void> {
		await this.tail;
	}
}
