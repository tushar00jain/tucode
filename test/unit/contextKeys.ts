export function contextKeys() {
	const values = new Map<string, unknown>();
	return {
		values,
		service: {
			createKey: (key: string, defaultValue: unknown) => {
				values.set(key, defaultValue);
				return { set: (value: unknown) => values.set(key, value), reset: () => values.set(key, defaultValue),
					get: () => values.get(key) };
			}
		}
	};
}
