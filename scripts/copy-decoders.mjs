// Copies three's Draco and Basis decoders into the shipped harness page (cli-app/public/_decoders, gitignored).
import { cpSync, mkdirSync } from 'node:fs';

const src = 'node_modules/three/examples/jsm/libs';
mkdirSync('cli-app/public/_decoders', { recursive: true });
cpSync(`${src}/draco/gltf`, 'cli-app/public/_decoders/draco', { recursive: true });
cpSync(`${src}/basis`, 'cli-app/public/_decoders/basis', { recursive: true });
console.log('decoders copied to cli-app/public/_decoders');
