import { createRouter } from '@tanstack/react-router';

import { ROUTER_OPTIONS } from './router-options.ts';
import { routeTree } from './routeTree.gen.ts';

// Start calls this for every request on the server, and once in the browser.
export const getRouter = () => createRouter({ ...ROUTER_OPTIONS, routeTree });
