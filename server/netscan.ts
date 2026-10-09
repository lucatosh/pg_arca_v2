import net from 'net';
import os from 'os';
import type { Request, Response } from 'express';
import { broadcastLiveLog } from './logs';

// ==============================================================================
// High-Performance Real Network Scanner & Prober Engine
// ==============================================================================

export interface DiscoveredEndpoint {
  host: string;
  port: number;
  open: boolean;
  service: 'PostgreSQL' | 'Patroni REST API' | 'ETCD Client API' | 'PgBouncer' | 'pg_arca Node Agent' | 'TCP Service';
  latencyMs: number;
  banner?: string;
  patroniData?: any;
  agentData?: any;
}

export interface DiscoveredClusterSynthesis {
  id: string;
  name: string;
  environment: 'prod' | 'prep' | 'int' | 'dev' | 'test';
  dcsType: 'etcd' | 'consul' | 'k8s-api';
  dcsEndpoint: string;
  pgVersion: string;
  activeTimeline: number;
  nodes: {
    name: string;
    role: 'primary' | 'sync_standby' | 'replica' | 'standby_leader';
    host: string;
    port: number;
    latencyMs: number;
    state: string;
  }[];
  isRealNetworkDetected: boolean;
}

function ipToLong(ip: string): number | null {
  const parts = ip.trim().split('.');
  if (parts.length !== 4) return null;
  let num = 0;
  for (let i = 0; i < 4; i++) {
    const part = parseInt(parts[i], 10);
    if (isNaN(part) || part < 0 || part > 255) return null;
    num = (num << 8) + part;
  }
  return num >>> 0;
}

function longToIp(num: number): string {
  return [
    (num >>> 24) & 255,
    (num >>> 16) & 255,
    (num >>> 8) & 255,
    num & 255
  ].join('.');
}

export function parseCidrToIps(cidrOrIps: string, maxHosts = 256): string[] {
  const ips: string[] = [];
  const parts = cidrOrIps.split(',').map(s => s.trim()).filter(Boolean);

  for (const part of parts) {
    if (part.includes('/')) {
      const [ip, maskStr] = part.split('/');
      const mask = parseInt(maskStr, 10);
      if (isNaN(mask) || mask < 16 || mask > 32) continue;

      const ipNum = ipToLong(ip);
      if (ipNum === null) continue;

      if (mask === 32) {
        ips.push(ip);
      } else {
        const totalHosts = Math.pow(2, 32 - mask);
        const countToTake = Math.min(totalHosts, maxHosts);
        const networkBase = (ipNum & (-1 << (32 - mask))) >>> 0;
        for (let i = 1; i < countToTake - 1; i++) {
          ips.push(longToIp(networkBase + i));
          if (ips.length >= maxHosts) break;
        }
      }
    } else {
      ips.push(part);
    }
    if (ips.length >= maxHosts) break;
  }
  return Array.from(new Set(ips));
}

export function getHostNetworkInterfaces() {
  const ifaces = os.networkInterfaces();
  const result: Array<{ name: string; ip: string; netmask: string; cidr: string; isInternal: boolean }> = [];

  for (const [name, addrs] of Object.entries(ifaces)) {
    if (!addrs) continue;
    for (const addr of addrs) {
      if (addr.family === 'IPv4') {
        const maskParts = addr.netmask.split('.').map(Number);
        const bits = maskParts.reduce((acc, octet) => acc + (octet.toString(2).match(/1/g) || []).length, 0);
        const ipNum = ipToLong(addr.address);
        if (ipNum !== null) {
          const networkBase = (ipNum & (-1 << (32 - bits))) >>> 0;
          const cidr = `${longToIp(networkBase)}/${bits}`;
          result.push({
            name,
            ip: addr.address,
            netmask: addr.netmask,
            cidr,
            isInternal: addr.internal
          });
        }
      }
    }
  }

  // Ensure loopback is always present for local scanning
  if (!result.some(r => r.ip === '127.0.0.1')) {
    result.push({
      name: 'lo',
      ip: '127.0.0.1',
      netmask: '255.0.0.0',
      cidr: '127.0.0.1/32',
      isInternal: true
    });
  }

  return result;
}

export function probeTcpEndpoint(host: string, port: number, timeoutMs = 280): Promise<DiscoveredEndpoint> {
  return new Promise((resolve) => {
    const start = Date.now();
    const socket = new net.Socket();
    let isResolved = false;

    socket.setTimeout(timeoutMs);

    socket.on('connect', async () => {
      const latencyMs = Math.max(1, Date.now() - start);
      isResolved = true;

      // Identify service based on port & protocol handshakes
      if (port === 5432) {
        try {
          // PostgreSQL SSLRequest packet: [0, 0, 0, 8, 4, 210, 22, 47]
          const sslPacket = Buffer.from([0x00, 0x00, 0x00, 0x08, 0x04, 0xd2, 0x16, 0x2f]);
          socket.write(sslPacket);
          socket.once('data', (buf) => {
            const resp = buf.toString('utf8', 0, 1);
            socket.destroy();
            resolve({
              host,
              port,
              open: true,
              service: 'PostgreSQL',
              latencyMs,
              banner: resp === 'S' || resp === 'N' ? 'PostgreSQL 14-17 (Handshake OK)' : 'PostgreSQL Protocol Server'
            });
          });
          setTimeout(() => {
            if (!socket.destroyed) {
              socket.destroy();
              resolve({
                host,
                port,
                open: true,
                service: 'PostgreSQL',
                latencyMs,
                banner: 'PostgreSQL TCP Listener'
              });
            }
          }, 80);
          return;
        } catch {
          // fallback
        }
      }

      socket.destroy();

      // For Patroni REST API (8008), probe HTTP endpoint
      if (port === 8008) {
        try {
          const controller = new AbortController();
          const tId = setTimeout(() => controller.abort(), 600);
          const res = await fetch(`http://${host}:8008/cluster`, { signal: controller.signal });
          clearTimeout(tId);
          if (res.ok) {
            const data = await res.json();
            return resolve({
              host,
              port,
              open: true,
              service: 'Patroni REST API',
              latencyMs,
              banner: `Patroni Cluster: ${data.scope || 'HA'}`,
              patroniData: data
            });
          }
        } catch {
          // fallback
        }
        return resolve({
          host,
          port,
          open: true,
          service: 'Patroni REST API',
          latencyMs,
          banner: 'Patroni REST API (Port 8008)'
        });
      }

      // For pg_arca agent (9898)
      if (port === 9898) {
        try {
          const controller = new AbortController();
          const tId = setTimeout(() => controller.abort(), 600);
          const res = await fetch(`http://${host}:9898/api/status`, { signal: controller.signal });
          clearTimeout(tId);
          if (res.ok) {
            const data = await res.json();
            return resolve({
              host,
              port,
              open: true,
              service: 'pg_arca Node Agent',
              latencyMs,
              banner: `pg_arca Agent (${data.agent?.node || host})`,
              agentData: data
            });
          }
        } catch {
          // fallback
        }
        return resolve({
          host,
          port,
          open: true,
          service: 'pg_arca Node Agent',
          latencyMs,
          banner: 'pg_arca Agent Listener'
        });
      }

      // For ETCD (2379)
      if (port === 2379) {
        return resolve({
          host,
          port,
          open: true,
          service: 'ETCD Client API',
          latencyMs,
          banner: 'ETCD Consensus DCS'
        });
      }

      // For PgBouncer (6432)
      if (port === 6432) {
        return resolve({
          host,
          port,
          open: true,
          service: 'PgBouncer',
          latencyMs,
          banner: 'PgBouncer Connection Pooler'
        });
      }

      resolve({
        host,
        port,
        open: true,
        service: 'TCP Service',
        latencyMs
      });
    });

    socket.on('timeout', () => {
      if (!isResolved) {
        isResolved = true;
        socket.destroy();
        resolve({
          host,
          port,
          open: false,
          service: 'TCP Service',
          latencyMs: timeoutMs
        });
      }
    });

    socket.on('error', () => {
      if (!isResolved) {
        isResolved = true;
        socket.destroy();
        resolve({
          host,
          port,
          open: false,
          service: 'TCP Service',
          latencyMs: Math.max(1, Date.now() - start)
        });
      }
    });

    socket.connect(port, host);
  });
}

export async function scanNetworkTargets(
  ipList: string[],
  ports: number[],
  timeoutMs = 280,
  concurrency = 25
): Promise<{
  activeEndpoints: DiscoveredEndpoint[];
  discoveredClusters: DiscoveredClusterSynthesis[];
  discoveredAgents: any[];
  allEndpointsCount: number;
}> {
  const probes: Array<{ host: string; port: number }> = [];
  for (const host of ipList) {
    for (const port of ports) {
      probes.push({ host, port });
    }
  }

  const results: DiscoveredEndpoint[] = [];
  for (let i = 0; i < probes.length; i += concurrency) {
    const chunk = probes.slice(i, i + concurrency);
    const chunkResults = await Promise.all(
      chunk.map(p => probeTcpEndpoint(p.host, p.port, timeoutMs))
    );
    for (const r of chunkResults) {
      if (r.open) {
        results.push(r);
      }
    }
  }

  // Synthesize clusters from discovered endpoints
  const discoveredClusters: DiscoveredClusterSynthesis[] = [];
  const discoveredAgents: any[] = [];

  // Group by Patroni scope if found
  const patroniEndpoints = results.filter(r => r.service === 'Patroni REST API');
  const postgresEndpoints = results.filter(r => r.service === 'PostgreSQL');

  for (const pe of patroniEndpoints) {
    const pData = pe.patroniData;
    const clusterName = pData?.scope || `patroni-cluster-${pe.host.replace(/\./g, '-')}`;
    
    // Check if cluster already synthesized
    let clusterSyn = discoveredClusters.find(c => c.name === clusterName);
    if (!clusterSyn) {
      clusterSyn = {
        id: `disc-net-${clusterName}`,
        name: clusterName,
        environment: 'prod',
        dcsType: 'etcd',
        dcsEndpoint: `http://${pe.host}:2379`,
        pgVersion: '16.4',
        activeTimeline: pData?.timeline || 1,
        nodes: [],
        isRealNetworkDetected: true
      };
      discoveredClusters.push(clusterSyn);
    }

    // Add nodes from patroniData members if present
    if (Array.isArray(pData?.members)) {
      for (const m of pData.members) {
        if (!clusterSyn.nodes.some(n => n.name === m.name)) {
          clusterSyn.nodes.push({
            name: m.name,
            role: m.role === 'leader' || m.role === 'primary' ? 'primary' : 'sync_standby',
            host: m.host || pe.host,
            port: m.port || 5432,
            latencyMs: pe.latencyMs,
            state: m.state || 'running'
          });
        }
      }
    } else {
      clusterSyn.nodes.push({
        name: `node-${pe.host.replace(/\./g, '-')}`,
        role: 'primary',
        host: pe.host,
        port: 5432,
        latencyMs: pe.latencyMs,
        state: 'running'
      });
    }
  }

  // If standalone Postgres instances found without Patroni
  for (const pge of postgresEndpoints) {
    const alreadyInPatroni = discoveredClusters.some(c => c.nodes.some(n => n.host === pge.host));
    if (!alreadyInPatroni) {
      discoveredClusters.push({
        id: `disc-pg-${pge.host.replace(/\./g, '-')}`,
        name: `pg-standalone-${pge.host.replace(/\./g, '-')}`,
        environment: 'dev',
        dcsType: 'etcd',
        dcsEndpoint: `http://${pge.host}:2379`,
        pgVersion: '16.4',
        activeTimeline: 1,
        nodes: [
          {
            name: `pg-${pge.host.replace(/\./g, '-')}`,
            role: 'primary',
            host: pge.host,
            port: pge.port,
            latencyMs: pge.latencyMs,
            state: 'running'
          }
        ],
        isRealNetworkDetected: true
      });
    }
  }

  // Agents
  const agentEndpoints = results.filter(r => r.service === 'pg_arca Node Agent');
  for (const ae of agentEndpoints) {
    discoveredAgents.push({
      host: ae.host,
      port: ae.port,
      agentData: ae.agentData,
      latencyMs: ae.latencyMs
    });
  }

  return {
    activeEndpoints: results,
    discoveredClusters,
    discoveredAgents,
    allEndpointsCount: probes.length
  };
}


export function mountNetscanRoutes(app: any) {
  app.get('/api/network/interfaces', (_req: Request, res: Response) => {
    const ifaces = getHostNetworkInterfaces();
    const subnets = Array.from(new Set(ifaces.map(i => i.cidr)));
    res.json({ interfaces: ifaces, detectedSubnets: subnets, defaultTarget: subnets.join(', ') });
  });
  app.post('/api/network/scan', async (req: Request, res: Response) => {
    const { targets = '127.0.0.1', ports = [5432, 8008, 2379, 6432, 9898], timeoutMs = 280, concurrency = 25 } = req.body || {};
    if (typeof targets !== 'string' || !Array.isArray(ports) || ports.length > 20 || !ports.every((p: any) => Number.isInteger(p) && p > 0 && p < 65536)) return res.status(400).json({ error: 'invalid_input' });
    const t0 = Date.now();
    const ipList = parseCidrToIps(targets, 256);
    const scan = await scanNetworkTargets(ipList, ports, Math.min(Number(timeoutMs) || 280, 3000), Math.min(Number(concurrency) || 25, 64));
    const durationMs = Date.now() - t0;
    broadcastLiveLog({ timestamp: new Date().toISOString(), clusterId: 'network', clusterName: 'Network scanner', nodeName: 'console', nodeHost: '127.0.0.1', service: 'agent', level: 'INFO',
      message: `Scansione di rete: ${ipList.length} IP, ${scan.activeEndpoints.length} servizi raggiungibili in ${durationMs}ms`, raw: `[NET-SCAN] targets=${targets} ips=${ipList.length} endpoints=${scan.activeEndpoints.length}` });
    res.json({ success: true, durationMs, scannedIpsCount: ipList.length, ...scan });
  });
}
