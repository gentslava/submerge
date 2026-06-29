// Генерация mihomo config.yaml из набора узлов.
import yaml from 'js-yaml';
import { writeFileSync } from 'node:fs';

export function buildConfig(proxies) {
  const names = proxies.map((p) => p.name);
  const cfg = {
    'mixed-port': 7890,
    'allow-lan': true,
    'bind-address': '*',
    mode: 'rule',
    'log-level': 'info',
    ipv6: false,
    'external-controller': '0.0.0.0:9090',
    secret: 'poc',
    proxies,
    'proxy-groups': [
      { name: 'PROXY', type: 'select', proxies: ['AUTO', ...names, 'DIRECT'] },
      {
        name: 'AUTO',
        type: 'url-test',
        url: 'https://www.gstatic.com/generate_204',
        interval: 300,
        tolerance: 50,
        proxies: names.length ? names : ['DIRECT'],
      },
    ],
    rules: [names.length ? 'MATCH,PROXY' : 'MATCH,DIRECT'],
  };
  return yaml.dump(cfg, { lineWidth: -1 });
}

export function writeConfig(path, proxies) {
  writeFileSync(path, buildConfig(proxies), 'utf8');
}
