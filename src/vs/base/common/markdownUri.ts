import { dirname, resolvePath } from './resources.js';
import { URI } from './uri.js';

/** Resolve URL components before treating the decoded path as a filesystem path. */
export function resolveMarkdownUri(baseUri: URI, href: string): string {
	if (/^\w[\w\d+.-]*:/.test(href)) {
		return href;
	}
	if (href.startsWith('//')) {
		return `${baseUri.scheme === 'http' ? 'http' : 'https'}:${href}`;
	}
	// A synthetic scheme avoids URI.parse's default file scheme, which makes relative
	// paths absolute. URI.parse decodes escapes once and separates query and fragment.
	const relative = URI.parse(`markdown-relative:${href}`);
	const directory = baseUri.path.endsWith('/') ? baseUri : dirname(baseUri);
	const resolved = relative.path ? resolvePath(directory, relative.path) : baseUri;
	return resolved.with({ query: relative.query, fragment: relative.fragment }).toString();
}
