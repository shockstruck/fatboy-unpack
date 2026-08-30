// Process-wide queue for interactive browser windows. Every code path that
// opens a visible Chrome (download catcher, FuckingFast resolver, FileCrypt
// renderer) runs through this so the user only ever faces one window at a
// time, even when several downloads or updates resolve concurrently.
let tail: Promise<unknown> = Promise.resolve();

export function withBrowserWindow<T>(task: () => Promise<T>): Promise<T> {
	const run = tail.then(task, task);
	tail = run.catch(() => {});
	return run;
}
