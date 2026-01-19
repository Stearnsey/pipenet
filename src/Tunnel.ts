import axios from 'axios';
import debug from 'debug';
import { EventEmitter } from 'events';

import { TunnelCluster, TunnelClusterOptions } from './TunnelCluster.js';

const log = debug('pipenet:client');

export interface TunnelOptions {
  allow_invalid_cert?: boolean;
  headers?: Record<string, string>;
  host?: string;
  local_ca?: string;
  local_cert?: string;
  local_host?: string;
  local_https?: boolean;
  local_key?: string;
  port?: number;
  subdomain?: string;
}

interface ServerResponse {
  cached_url?: string;
  id: string;
  ip: string;
  max_conn_count?: number;
  message?: string;
  port: number;
  url: string;
}

interface TunnelInfo extends TunnelClusterOptions {
  allow_invalid_cert?: boolean;
  cached_url?: string;
  local_ca?: string;
  local_cert?: string;
  local_host?: string;
  local_https?: boolean;
  local_key?: string;
  local_port?: number;
  max_conn: number;
  name: string;
  remote_host: string;
  remote_ip: string;
  remote_port: number;
  url: string;
}

export class Tunnel extends EventEmitter {
  public cachedUrl?: string;
  public clientId?: string;
  public closed: boolean;
  public opts: TunnelOptions;
  public tunnelCluster?: TunnelCluster;
  public url?: string;

  constructor(opts: TunnelOptions = {}) {
    super();
    this.opts = opts;
    this.closed = false;
    if (!this.opts.host) {
      this.opts.host = 'https://pipenet.dev';
    }
  }

  close(): void {
    this.closed = true;
    this.emit('close');
  }

  open(cb: (err?: Error) => void): void {
    this._init((err, info) => {
      if (err) {
        cb(err);
        return;
      }

      this.clientId = info!.name;
      this.url = info!.url;

      if (info!.cached_url) {
        this.cachedUrl = info!.cached_url;
      }

      this._establish(info!);
      cb();
    });
  }

  private _establish(info: TunnelInfo): void {
    this.setMaxListeners(info.max_conn + (EventEmitter.defaultMaxListeners || 10));

    this.tunnelCluster = new TunnelCluster(info);

    this.tunnelCluster.once('open', () => {
      this.emit('url', info.url);
    });

    this.tunnelCluster.on('error', (err: Error) => {
      log('got socket error', err.message);
      this.emit('error', err);
    });

    let tunnelCount = 0;

    this.tunnelCluster.on('open', (tunnel: { destroy: () => void; once: (event: string, handler: () => void) => void }) => {
      tunnelCount++;
      log('tunnel open [total: %d]', tunnelCount);

      const closeHandler = (): void => {
        tunnel.destroy();
      };

      if (this.closed) {
        closeHandler();
        return;
      }

      this.once('close', closeHandler);
      tunnel.once('close', () => {
        this.removeListener('close', closeHandler);
      });
    });

    this.tunnelCluster.on('dead', () => {
      tunnelCount--;
      log('tunnel dead [total: %d]', tunnelCount);
      if (this.closed) {
        return;
      }
      this.tunnelCluster!.open();
    });

    this.tunnelCluster.on('request', (req) => {
      this.emit('request', req);
    });

    for (let count = 0; count < info.max_conn; ++count) {
      this.tunnelCluster.open();
    }
  }

  private _getInfo(body: ServerResponse): TunnelInfo {
    const { cached_url, id, ip, max_conn_count, port, url } = body;
    const { host, local_host, port: local_port } = this.opts;
    const { allow_invalid_cert, local_ca, local_cert, local_https, local_key } = this.opts;
    
    return {
      allow_invalid_cert,
      cached_url,
      local_ca,
      local_cert,
      local_host,
      local_https,
      local_key,
      local_port,
      max_conn: max_conn_count || 1,
      name: id,
      remote_host: new URL(host!).hostname,
      remote_ip: ip,
      remote_port: port,
      url,
    };
  }

  private _init(cb: (err: Error | null, info?: TunnelInfo) => void): void {
    const opt = this.opts;
    const getInfo = this._getInfo.bind(this);

    const params = {
      headers: opt.headers || {},
      responseType: 'json' as const,
    };

    const baseUri = `${opt.host}/`;
    const assignedDomain = opt.subdomain;
    const uri = baseUri + (assignedDomain || '?new');

    const getUrl = (): void => {
      axios
        .get<ServerResponse>(uri, params)
        .then((res) => {
          const body = res.data;
          log('got tunnel information', res.data);
          if (res.status !== 200) {
            const err = new Error(
              body?.message || 'pipenet server returned an error, please try again'
            );
            return cb(err);
          }
          cb(null, getInfo(body));
        })
        .catch((err: Error) => {
          log(`tunnel server offline: ${err.message}, retry 1s`);
          setTimeout(getUrl, 1000);
        });
    };

    getUrl();
  }
}

