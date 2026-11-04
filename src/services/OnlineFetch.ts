import * as https from "https";
import * as zlib from "zlib";
import { onlineLookupsEnabled } from "./Settings";

const MAX_BYTES = 64 * 1024 * 1024;

/**
 * The only place where PackageHub itself opens a network connection. It runs
 * only when packageHub.onlineLookups is on, and only for https URLs.
 * Uses the https module so it works on every supported editor (some ship a
 * Node.js without fetch).
 */
export function fetchOnlineJson(url: string, timeoutMs = 20000): Promise<any> {
    if (!onlineLookupsEnabled()) {
        return Promise.reject(new Error("packageHub.onlineLookups is off."));
    }
    if (!url.startsWith("https://")) {
        return Promise.reject(new Error(`Only https is allowed: ${url}`));
    }
    return new Promise((resolve, reject) => {
        const request = https.get(url, {
            headers: { Accept: "application/json", "Accept-Encoding": "gzip, deflate" },
            timeout: timeoutMs,
        }, (response) => {
            const status = response.statusCode ?? 0;
            if (status < 200 || status >= 300) {
                response.resume();
                reject(new Error(`${status} ${url}`));
                return;
            }
            const chunks: Buffer[] = [];
            let size = 0;
            response.on("data", (chunk: Buffer) => {
                size += chunk.length;
                if (size > MAX_BYTES) {
                    request.destroy(new Error(`Response too large: ${url}`));
                    return;
                }
                chunks.push(chunk);
            });
            response.on("error", reject);
            response.on("end", () => {
                try {
                    let body = Buffer.concat(chunks);
                    const encoding = String(response.headers["content-encoding"] || "").toLowerCase();
                    if (encoding === "gzip") {
                        body = zlib.gunzipSync(body);
                    } else if (encoding === "deflate") {
                        body = zlib.inflateSync(body);
                    }
                    resolve(JSON.parse(body.toString("utf8")));
                } catch (error) {
                    reject(error);
                }
            });
        });
        request.on("timeout", () => request.destroy(new Error(`Timed out: ${url}`)));
        request.on("error", reject);
    });
}
