/**
 * Handing leased events to the caller's output, one at a time, and only then
 * finishing them.
 *
 * This is the whole of `--delete-on-success`, and it lives here rather than
 * inline in the CLI so it can be tested without spawning a process. The ordering
 * is the entire point: an event is destroyed AFTER it has been written out
 * without error, never before. A pull that dies halfway -- a full disk, a closed
 * pipe, a killed consumer -- leaves the remainder LEASED rather than destroyed,
 * so the lease expires and someone gets another go at them.
 *
 * Getting that backwards is how a queue silently eats messages: delete-then-write
 * looks identical on every run that succeeds.
 */

export interface EmitResult<T> {
	/** Written out and finished, in order. */
	finished: T[];
	/** Never finished: the one that failed to write, and everything after it. */
	remaining: T[];
	/** What the write threw, if it did. */
	error?: unknown;
}

export interface EmitOptions<T> {
	events: T[];
	/** Write one event to the caller's output. Throwing stops the run. */
	write: (event: T, index: number) => void | Promise<void>;
	/** Finish it -- remove or delete. Only ever called after `write` returned. */
	finish?: (event: T) => void | Promise<void>;
}

export async function emitEvents<T>(opts: EmitOptions<T>): Promise<EmitResult<T>> {
	const finished: T[] = [];

	for (let i = 0; i < opts.events.length; i++) {
		const event = opts.events[i];
		try {
			await opts.write(event, i);
		} catch (error) {
			// Stop here. Everything from this one on stays leased -- including this
			// one, which we cannot prove the caller ever saw.
			return { finished, remaining: opts.events.slice(i), error };
		}
		if (opts.finish) await opts.finish(event);
		finished.push(event);
	}

	return { finished, remaining: [] };
}
