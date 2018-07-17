import * as fs from 'fs';
import * as path from 'path';
import { URL } from 'url';
import { ClientRequest, ServerResponse } from 'http';
import cookie from 'cookie';
import devalue from 'devalue';
import fetch from 'node-fetch';
import { lookup } from './middleware/mime';
import { locations, dev } from './config';
import sourceMapSupport from 'source-map-support';

sourceMapSupport.install();

type ServerRoute = {
	pattern: RegExp;
	handlers: Record<string, Handler>;
	params: (match: RegExpMatchArray) => Record<string, string>;
};

type Page = {
	pattern: RegExp;
	parts: Array<{
		name: string;
		component: Component;
		params?: (match: RegExpMatchArray) => Record<string, string>;
	}>
};

type RouteObject = {
	server_routes: ServerRoute[];
	pages: Page[];
	root: Component;
	error: Component;
}

type Handler = (req: Req, res: ServerResponse, next: () => void) => void;

type Store = {
	get: () => any
};

interface Req extends ClientRequest {
	url: string;
	baseUrl: string;
	originalUrl: string;
	method: string;
	path: string;
	params: Record<string, string>;
	query: Record<string, string>;
	headers: Record<string, string>;
}

interface Component {
	render: (data: any, opts: { store: Store }) => {
		head: string;
		css: { code: string, map: any };
		html: string
	},
	preload: (data: any) => any | Promise<any>
}

export default function middleware({ routes, store }: {
	routes: RouteObject,
	store: (req: Req) => Store
}) {
	const output = locations.dest();

	let emitted_basepath = false;

	const middleware = compose_handlers([
		(req: Req, res: ServerResponse, next: () => void) => {
			if (req.baseUrl === undefined) {
				let { originalUrl } = req;
				if (req.url === '/' && originalUrl[originalUrl.length - 1] !== '/') {
					originalUrl += '/';
				}

				req.baseUrl = originalUrl
					? originalUrl.slice(0, -req.url.length)
					: '';
			}

			if (!emitted_basepath && process.send) {
				process.send({
					__sapper__: true,
					event: 'basepath',
					basepath: req.baseUrl
				});

				emitted_basepath = true;
			}

			if (req.path === undefined) {
				req.path = req.url.replace(/\?.*/, '');
			}

			next();
		},

		fs.existsSync(path.join(output, 'index.html')) && serve({
			pathname: '/index.html',
			cache_control: 'max-age=600'
		}),

		fs.existsSync(path.join(output, 'service-worker.js')) && serve({
			pathname: '/service-worker.js',
			cache_control: 'max-age=600'
		}),

		fs.existsSync(path.join(output, 'service-worker.js.map')) && serve({
			pathname: '/service-worker.js.map',
			cache_control: 'max-age=600'
		}),

		serve({
			prefix: '/client/',
			cache_control: 'max-age=31536000'
		}),

		get_server_route_handler(routes.server_routes),
		get_page_handler(routes, store)
	].filter(Boolean));

	return middleware;
}

function serve({ prefix, pathname, cache_control }: {
	prefix?: string,
	pathname?: string,
	cache_control: string
}) {
	const filter = pathname
		? (req: Req) => req.path === pathname
		: (req: Req) => req.path.startsWith(prefix);

	const output = locations.dest();

	const cache: Map<string, Buffer> = new Map();

	const read = dev()
		? (file: string) => fs.readFileSync(path.resolve(output, file))
		: (file: string) => (cache.has(file) ? cache : cache.set(file, fs.readFileSync(path.resolve(output, file)))).get(file)

	return (req: Req, res: ServerResponse, next: () => void) => {
		if (filter(req)) {
			const type = lookup(req.path);

			try {
				const data = read(req.path.slice(1));

				res.setHeader('Content-Type', type);
				res.setHeader('Cache-Control', cache_control);
				res.end(data);
			} catch (err) {
				res.statusCode = 404;
				res.end('not found');
			}
		} else {
			next();
		}
	};
}

function get_server_route_handler(routes: ServerRoute[]) {
	function handle_route(route: ServerRoute, req: Req, res: ServerResponse, next: () => void) {
		req.params = route.params(route.pattern.exec(req.path));

		const method = req.method.toLowerCase();
		// 'delete' cannot be exported from a module because it is a keyword,
		// so check for 'del' instead
		const method_export = method === 'delete' ? 'del' : method;
		const handle_method = route.handlers[method_export];
		if (handle_method) {
			if (process.env.SAPPER_EXPORT) {
				const { write, end, setHeader } = res;
				const chunks: any[] = [];
				const headers: Record<string, string> = {};

				// intercept data so that it can be exported
				res.write = function(chunk: any) {
					chunks.push(new Buffer(chunk));
					write.apply(res, arguments);
				};

				res.setHeader = function(name: string, value: string) {
					headers[name.toLowerCase()] = value;
					setHeader.apply(res, arguments);
				};

				res.end = function(chunk?: any) {
					if (chunk) chunks.push(new Buffer(chunk));
					end.apply(res, arguments);

					process.send({
						__sapper__: true,
						event: 'file',
						url: req.url,
						method: req.method,
						status: res.statusCode,
						type: headers['content-type'],
						body: Buffer.concat(chunks).toString()
					});
				};
			}

			const handle_next = (err?: Error) => {
				if (err) {
					res.statusCode = 500;
					res.end(err.message);
				} else {
					process.nextTick(next);
				}
			};

			try {
				handle_method(req, res, handle_next);
			} catch (err) {
				handle_next(err);
			}
		} else {
			// no matching handler for method
			process.nextTick(next);
		}
	}

	return function find_route(req: Req, res: ServerResponse, next: () => void) {
		for (const route of routes) {
			if (route.pattern.test(req.path)) {
				handle_route(route, req, res, next);
				return;
			}
		}

		next();
	};
}

function get_page_handler(routes: RouteObject, store_getter: (req: Req) => Store) {
	const output = locations.dest();

	const get_chunks = dev()
		? () => JSON.parse(fs.readFileSync(path.join(output, 'client_assets.json'), 'utf-8'))
		: (assets => () => assets)(JSON.parse(fs.readFileSync(path.join(output, 'client_assets.json'), 'utf-8')));

	const template = dev()
		? () => fs.readFileSync(`${locations.app()}/template.html`, 'utf-8')
		: (str => () => str)(fs.readFileSync(`${locations.dest()}/template.html`, 'utf-8'));

	const { server_routes, pages } = routes;
	const error_route = routes.error;

	function handle_page(page: Page, req: Req, res: ServerResponse, status = 200, error: Error | string = null) {
		const get_params = page.parts[page.parts.length - 1].params || (() => ({}));
		const match = page.pattern.exec(req.path);

		req.params = error
			? {}
			: get_params(match);

		const chunks: Record<string, string | string[]> = get_chunks();

		res.setHeader('Content-Type', 'text/html');

		// preload main.js and current route
		// TODO detect other stuff we can preload? images, CSS, fonts?
		let preloaded_chunks = Array.isArray(chunks.main) ? chunks.main : [chunks.main];
		if (!error) {
			page.parts.forEach(part => {
				// using concat because it could be a string or an array. thanks webpack!
				preloaded_chunks = preloaded_chunks.concat(chunks[part.name]);
			});
		}

		const link = preloaded_chunks
			.filter(file => !file.match(/\.map$/))
			.map(file => `<${req.baseUrl}/client/${file}>;rel="preload";as="script"`)
			.join(', ');

		res.setHeader('Link', link);

		const store = store_getter ? store_getter(req) : null;
		const props = { query: req.query, path: req.path };

		if (error) {
			props.error = error instanceof Error ? error : { message: error };
			props.status = status;
		}

		let redirect: { statusCode: number, location: string };
		let preload_error: { statusCode: number, message: Error | string };

		Promise.all(page.parts.map(part => {
			return part.component.preload
				? part.component.preload.call({
					redirect: (statusCode: number, location: string) => {
						if (redirect && (redirect.statusCode !== statusCode || redirect.location !== location)) {
							throw new Error(`Conflicting redirects`);
						}
						redirect = { statusCode, location };
					},
					error: (statusCode: number, message: Error | string) => {
						preload_error = { statusCode, message };
					},
					fetch: (url: string, opts?: any) => {
						const parsed = new URL(url, `http://127.0.0.1:${process.env.PORT}${req.baseUrl ? req.baseUrl + '/' :''}`);

						if (opts) {
							opts = Object.assign({}, opts);

							const include_cookies = (
								opts.credentials === 'include' ||
								opts.credentials === 'same-origin' && parsed.origin === `http://127.0.0.1:${process.env.PORT}`
							);

							if (include_cookies) {
								const cookies: Record<string, string> = {};
								if (!opts.headers) opts.headers = {};

								const str = []
									.concat(
										cookie.parse(req.headers.cookie || ''),
										cookie.parse(opts.headers.cookie || ''),
										cookie.parse(res.getHeader('Set-Cookie') || '')
									)
									.map(cookie => {
										return Object.keys(cookie)
											.map(name => `${name}=${encodeURIComponent(cookie[name])}`)
											.join('; ');
									})
									.filter(Boolean)
									.join(', ');

								opts.headers.cookie = str;
							}
						}

						return fetch(parsed.href, opts);
					},
					store
				}, req)
				: {};
		})).catch(err => {
			preload_error = { statusCode: 500, message: err };
			return []; // appease TypeScript
		}).then(preloaded => {
			if (redirect) {
				res.statusCode = redirect.statusCode;
				res.setHeader('Location', `${req.baseUrl}/${redirect.location}`);
				res.end();

				return;
			}

			if (preload_error) {
				handle_page({
					pattern: null,
					parts: [
						{ name: null, component: error_route }
					]
				}, req, res, preload_error.statusCode, preload_error.message);

				return;
			}

			const serialized = {
				preloaded: page.parts.map((part, i) => {
					return part.component.preload ? try_serialize(preloaded[i]) : null;
				}),
				store: store && try_serialize(store.get())
			};

			const segments = req.path.split('/').filter(Boolean);

			const data = Object.assign({}, props, { params: req.params }, {
				child: {}
			});
			let level = data.child;
			for (let i = 0; i < page.parts.length; i += 1) {
				const part = page.parts[i];
				const get_params = part.params || (() => ({}));

				Object.assign(level, {
					segment: segments[i],
					component: part.component,
					props: Object.assign({}, props, {
						params: get_params(match),
						query: req.query
					}, preloaded[i])
				});
				if (i < preloaded.length - 1) {
					level.props.child = {};
				}
				level = level.props.child;
			}

			const { html, head, css } = routes.root.render(data, {
				store
			});

			let scripts = []
				.concat(chunks.main) // chunks main might be an array. it might not! thanks, webpack
				.filter(file => !file.match(/\.map$/))
				.map(file => `<script src='${req.baseUrl}/client/${file}'></script>`)
				.join('');

			let inline_script = `__SAPPER__={${[
				`baseUrl: "${req.baseUrl}"`,
				serialized.preloaded && `preloaded: [${serialized.preloaded}]`,
				serialized.store && `store: ${serialized.store}`
			].filter(Boolean).join(',')}};`;

			const has_service_worker = fs.existsSync(path.join(locations.dest(), 'service-worker.js'));
			if (has_service_worker) {
				inline_script += `if ('serviceWorker' in navigator) navigator.serviceWorker.register('${req.baseUrl}/service-worker.js');`;
			}

			const body = template()
				.replace('%sapper.base%', () => `<base href="${req.baseUrl}/">`)
				.replace('%sapper.scripts%', () => `<script>${inline_script}</script>${scripts}`)
				.replace('%sapper.html%', () => html)
				.replace('%sapper.head%', () => `<noscript id='sapper-head-start'></noscript>${head}<noscript id='sapper-head-end'></noscript>`)
				.replace('%sapper.styles%', () => (css && css.code ? `<style>${css.code}</style>` : ''));

			res.statusCode = status;
			res.end(body);

			if (process.send) {
				process.send({
					__sapper__: true,
					event: 'file',
					url: req.url,
					method: req.method,
					status: 200,
					type: 'text/html',
					body
				});
			}
		}).catch(err => {
			res.statusCode = 500;
			res.end(err.message);
		});
	}

	return function find_route(req: Req, res: ServerResponse) {
		if (!server_routes.some(route => route.pattern.test(req.path))) {
			for (const page of pages) {
				if (page.pattern.test(req.path)) {
					handle_page(page, req, res);
					return;
				}
			}
		}

		handle_page({
			pattern: null,
			parts: [
				{ name: null, component: error_route }
			]
		}, req, res, 404, 'Not found');
	};
}

function compose_handlers(handlers: Handler[]) {
	return (req: Req, res: ServerResponse, next: () => void) => {
		let i = 0;
		function go() {
			const handler = handlers[i];

			if (handler) {
				handler(req, res, () => {
					i += 1;
					go();
				});
			} else {
				next();
			}
		}

		go();
	};
}

function try_serialize(data: any) {
	try {
		return devalue(data);
	} catch (err) {
		return null;
	}
}
