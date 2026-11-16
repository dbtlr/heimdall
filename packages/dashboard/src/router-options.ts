import { ErrorComponent } from '@tanstack/react-router';

// The options every dashboard router takes. A failed read shows its error
// inside the route that read it, so the layout, its navigation and refresh,
// and the update watcher in the shell stay up, and the next refresh can replace
// the error. Without a default, a read that fails on a refresh in the browser
// rises to the router's own boundary outside the shell and replaces the whole
// page.
export const ROUTER_OPTIONS = { defaultErrorComponent: ErrorComponent, scrollRestoration: true };
