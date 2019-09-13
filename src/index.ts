import {AxiosInstance, AxiosRequestConfig, AxiosResponse, AxiosStatic} from "axios";

// Types

export interface AxiosAuthRefreshOptions {
    instance?: AxiosInstance;
    statusCodes?: Array<number>;
}

export interface AxiosAuthRefreshCache {
    refreshCall: Promise<any>|undefined,
    requestQueueInterceptorId: number|undefined
}

export interface AxiosAuthRefreshRequestConfig extends AxiosRequestConfig {
    skipAuthRefresh?: boolean
}

// Constants

const defaults: AxiosAuthRefreshOptions = {
    statusCodes: [ 401 ],
    instance: undefined
};

const cache: AxiosAuthRefreshCache = {
    refreshCall: undefined,
    requestQueueInterceptorId: undefined
};

/**
 * Creates an authentication refresh interceptor that binds to any error response.
 * If the response code is 401, interceptor tries to call the refreshTokenCall which must return a Promise.
 * While refreshTokenCall is running, all new requests are intercepted and waiting for it to resolve.
 * After Promise is resolved/rejected the authentication refresh interceptor is revoked.
 * @param {AxiosStatic} axios - axios static object
 * @param {(error: any) => Promise<AxiosPromise>} refreshTokenCall - refresh token call which must return a Promise
 * @param {AxiosAuthRefreshOptions} options - options for the interceptor @see defaultOptions
 * @return {number} - interceptor id (in case you want to eject it manually)
 */
export default function createAuthRefreshInterceptor(
    axios: AxiosStatic,
    refreshTokenCall: (error: any) => Promise<any>,
    options: AxiosAuthRefreshOptions = {}
): number {
    if (typeof refreshTokenCall !== 'function') {
        throw new Error('axios-auth-refresh requires `refreshTokenCall` to be a function that returns a promise.');
    }

    // Get the instance of axios
    const axiosInstance = options.instance || axios;

    const id = axiosInstance.interceptors.response.use((res: AxiosResponse) => res, (error: any) => {

        // Rewrite default config
        options = mergeConfigs(options, defaults);

        // Reject promise if the error status is not in options.ports
        if (!shouldInterceptError(error, options)) {
            return Promise.reject(error);
        }

        // Remove the interceptor to prevent a loop in case token refresh also causes the 401
        axiosInstance.interceptors.response.eject(id);

        // If refresh call does not exist, create one
        const refreshing = createRefreshCall(error, refreshTokenCall, cache);

        // Create interceptor that will bind all the others requests until refreshTokenCall is resolved
        createRequestQueueInterceptor(axios, cache);

        // When response code is 401 (Unauthorized), try to refresh the token.
        return refreshing.then(() => {
            axiosInstance.interceptors.request.eject(cache.requestQueueInterceptorId);
            return axios(error.response.config);
        }).catch(error => {
            axiosInstance.interceptors.request.eject(cache.requestQueueInterceptorId);
            return Promise.reject(error);
        }).finally(() => {
            cache.refreshCall = undefined;
            cache.requestQueueInterceptorId = undefined;
            createAuthRefreshInterceptor(axios, refreshTokenCall, options)
        });
    });

    return id;
}

/**
 * Merges two config objects (master rewrites slave)
 */
export function mergeConfigs(master: AxiosAuthRefreshOptions, def: AxiosAuthRefreshOptions): AxiosAuthRefreshOptions {
    return { ...def, ...master };
}

/**
 * Returns TRUE: when error.response.status is contained in options.statusCodes
 * Returns FALSE: when error or error.response doesn't exist or options.statusCodes doesn't include response status
 */
export function shouldInterceptError(error: any, options: AxiosAuthRefreshOptions): boolean {
    return error
        && !(error.config && error.config.skipAuthRefresh)
        && error.response && options.statusCodes.includes(+error.response.status);
}

/**
 * Creates refresh call if it does not exist or returns the existing one
 */
export function createRefreshCall(
    error: any,
    fn: (error: any) => Promise<any>,
    cache: AxiosAuthRefreshCache
): Promise<any> {
    if (!cache.refreshCall) {
        cache.refreshCall = fn(error);
        if (typeof cache.refreshCall.then !== 'function') {
            console.warn('axios-auth-refresh requires `refreshTokenCall` to return a promise.');
            return Promise.reject();
        }
    }
    return cache.refreshCall;
}

/**
 * Creates refresh call if it does not exist or returns the existing one
 */
export function createRequestQueueInterceptor(axios: AxiosStatic, cache: AxiosAuthRefreshCache): number {
    if (typeof cache.requestQueueInterceptorId === 'undefined') {
        cache.requestQueueInterceptorId = axios
            .interceptors
            .request
            .use((request) => cache.refreshCall
                .then(() => request)
                .catch(() => {
                    throw new axios.Cancel('Refresh call failed')
                }));
    }
    return cache.requestQueueInterceptorId;
}