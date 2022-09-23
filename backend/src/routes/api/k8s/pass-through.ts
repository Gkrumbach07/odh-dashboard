import { FastifyRequest } from 'fastify';
import https, { RequestOptions } from 'https';
import { K8sResourceCommon, K8sStatus, KubeFastifyInstance } from '../../../types';
import { DEV_MODE, USER_ACCESS_TOKEN } from '../../../utils/constants';

type PassThroughData = {
  method: string;
  requestData: string;
  url: string;
};

const isK8sStatus = (data: Record<string, unknown>): data is K8sStatus => data.kind === 'Status';

const setupRequest = async (
  fastify: KubeFastifyInstance,
  request: FastifyRequest<{ Headers: { [USER_ACCESS_TOKEN]: string } }>,
  data: PassThroughData,
): Promise<{ url: string; requestOptions: RequestOptions }> => {
  const { method, url } = data;

  // TODO: Remove when bug is fixed - https://issues.redhat.com/browse/HAC-1825
  let safeURL = url;
  if (method.toLowerCase() === 'post') {
    // Core SDK builds the wrong path for k8s -- can't post to a resource name; remove the name from the url
    // eg: POST /.../configmaps/my-config-map => POST /.../configmaps
    const urlParts = url.split('/');
    urlParts.pop();
    safeURL = urlParts.join('/');
  }

  // Use our kube setup to boostrap our request
  const kc = fastify.kube.config;
  const kubeOptions: Parameters<typeof kc.applyToRequest>[0] = { url };
  await kc.applyToRequest(kubeOptions);
  const { headers: kubeHeaders, ca } = kubeOptions;

  // Adjust the header auth token
  let headers;
  if (DEV_MODE) {
    // In dev mode, we always are logged in fully -- no service accounts
    headers = kubeHeaders;
  } else {
    // When not in dev mode, we want to switch the token from the service account to the user
    const accessToken = request.headers[USER_ACCESS_TOKEN];
    if (!accessToken) {
      fastify.log.error(
        `No ${USER_ACCESS_TOKEN} header. Cannot make a pass through call as this user.`,
      );
      throw new Error('No access token provided by oauth. Cannot make any API calls to kube.');
    }
    headers = {
      ...kubeHeaders,
      Authorization: `Bearer ${accessToken}`,
    };
  }

  return {
    url: safeURL,
    requestOptions: {
      ca,
      headers,
      method,
    },
  };
};

export const passThrough = (
  fastify: KubeFastifyInstance,
  request: FastifyRequest<{ Headers: { [USER_ACCESS_TOKEN]: string } }>,
  data: PassThroughData,
): Promise<{ response: K8sResourceCommon }> => {
  const { method, requestData } = data;

  return new Promise((resolve, reject) => {
    setupRequest(fastify, request, data).then(({ url, requestOptions }) => {
      if (requestData) {
        requestOptions.headers = {
          ...requestOptions.headers,
          'Content-Type': `application/${
            method === 'PATCH' ? 'json-patch+json' : 'json'
          };charset=UTF-8`,
          'Content-Length': requestData.length,
        };
      }

      fastify.log.info(`Making API ${method} request to ${url}`);

      const httpsRequest = https
        .request(url, requestOptions, (res) => {
          let data = '';
          res
            .setEncoding('utf8')
            .on('data', (chunk) => {
              data += chunk;
            })
            .on('end', () => {
              let parsedData: K8sResourceCommon | K8sStatus;
              try {
                parsedData = JSON.parse(data);
              } catch (e) {
                // Likely not JSON, print the error and return the content to the client
                fastify.log.error(`Parsing response error: ${e}, ${data}`);
                reject({ code: 500, response: data });
                return;
              }

              if (isK8sStatus(parsedData)) {
                fastify.log.warn(`Status Object, ${JSON.stringify(parsedData, null, 2)}`);
                reject({ code: parsedData.code, response: parsedData });
                return;
              }

              fastify.log.info('Successful request, returning data to caller.');
              resolve({ response: parsedData });
            })
            .on('error', (error) => {
              if (error) {
                fastify.log.error(`Kube parsing response error: ${error}`);
                reject({ code: 500, response: error });
              }
            });
        })
        .on('error', (error) => {
          fastify.log.error(`Kube request error: ${error}`);
          reject({ code: 500, response: error });
        });

      if (requestData) {
        httpsRequest.write(requestData);
      }

      httpsRequest.end();
    });
  });
};