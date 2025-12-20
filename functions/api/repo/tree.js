import { proxyToCmsWorker } from "../../../_lib/proxyToCmsWorker";

export async function onRequest(context) {
	return proxyToCmsWorker(context.request, context.env);
}
