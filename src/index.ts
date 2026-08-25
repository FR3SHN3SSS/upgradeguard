import { McpServer } from '@modelcontextprotocol/server';
import { createMcpExpressApp } from '@modelcontextprotocol/express';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import * as z from 'zod/v4';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

interface PackageJsonInfo {
    path: string;
    data: {
      name?: string;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      [key: string]: unknown;
    };
  }
  
  function readPackageJson(repoPath: string): PackageJsonInfo | null {
    const packageJsonPath = join(repoPath, 'package.json');
    if (!existsSync(packageJsonPath)) {
      return null;
    }
    const raw = readFileSync(packageJsonPath, 'utf-8');
    const data = JSON.parse(raw);
    return { path: packageJsonPath, data };
  }


  interface RepositoryInspection {
    repoPath: string;
    packageManager: 'npm';
    packageJsonPath: string;
    hasLockfile: boolean;
    lockfilePath: string | null;
  }
  
  type InspectRepositoryResult =
    | { ok: true; data: RepositoryInspection }
    | { ok: false; error: string };
  
  function inspectRepository(repoPath: string): InspectRepositoryResult {
    const packageJsonPath = join(repoPath, 'package.json');
    const lockfilePath = join(repoPath, 'package-lock.json');
    const yarnLockPath = join(repoPath, 'yarn.lock');
    const pnpmLockPath = join(repoPath, 'pnpm-lock.yaml');
  
    if (!existsSync(packageJsonPath)) {
      return {
        ok: false,
        error: `No package.json found at ${packageJsonPath}. This does not appear to be a valid npm project.`
      };
    }
  
    const hasLockfile = existsSync(lockfilePath);

    if (!hasLockfile) {
        if (existsSync(yarnLockPath)) {
          return {
            ok: false,
            error: `Found yarn.lock instead of package-lock.json at ${repoPath}. This appears to be a Yarn project — UpgradeGuard's MVP only supports npm projects.`
          };
        }
        if (existsSync(pnpmLockPath)) {
          return {
            ok: false,
            error: `Found pnpm-lock.yaml instead of package-lock.json at ${repoPath}. This appears to be a pnpm project — UpgradeGuard's MVP only supports npm projects.`
          };
        }
      }
  
    return {
      ok: true,
      data: {
        repoPath,
        packageManager: 'npm',
        packageJsonPath,
        hasLockfile,
        lockfilePath: hasLockfile ? lockfilePath : null
      }
    };
  }
  
  type DependencyType = 'dependency' | 'devDependency';
  
  interface DependencyLookup {
    packageName: string;
    currentVersion: string;
    dependencyType: DependencyType;
  }
  
  type DependencyLookupResult =
    | { ok: true; data: DependencyLookup }
    | { ok: false; error: string };
  
  function lookupDependencyVersion(
    repoPath: string,
    packageName: string
  ): DependencyLookupResult {
    const pkg = readPackageJson(repoPath);
  
    if (!pkg) {
      return {
        ok: false,
        error: `No package.json found at ${join(repoPath, 'package.json')}.`
      };
    }
  
    const dependencies = pkg.data.dependencies ?? {};
    const devDependencies = pkg.data.devDependencies ?? {};
  
    if (packageName in dependencies) {
      return {
        ok: true,
        data: {
          packageName,
          currentVersion: dependencies[packageName],
          dependencyType: 'dependency'
        }
      };
    }
  
    if (packageName in devDependencies) {
      return {
        ok: true,
        data: {
          packageName,
          currentVersion: devDependencies[packageName],
          dependencyType: 'devDependency'
        }
      };
    }
  
    return {
      ok: false,
      error: `"${packageName}" was not found in dependencies or devDependencies of ${pkg.path}.`
    };
  }
  

function createServer(): McpServer {
  const server = new McpServer({
    name: 'upgradeguard-repo-tooling',
    version: '0.1.0'
  });

  server.registerTool(
    'inspect_repository',
    {
      description:
        'Inspect a Node.js repository on disk: confirm it looks like an npm project, locate package.json, and detect package-lock.json.',
      inputSchema: z.object({
        repoPath: z
          .string()
          .describe('Absolute path to the repository root on disk')
      })
    },
    async ({ repoPath }) => {
        const result = inspectRepository(repoPath);
  
        if (!result.ok) {
          return {
            content: [{ type: 'text', text: result.error }],
            isError: true
          };
        }
  
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  repoPath: result.data.repoPath,
                  packageManager: result.data.packageManager,
                  packageJson: {
                    found: true,
                    path: result.data.packageJsonPath
                  },
                  lockfile: {
                    found: result.data.hasLockfile,
                    path: result.data.lockfilePath
                  }
                },
                null,
                2
              )
            }
          ]
        };
      }
    );


  server.registerTool(
    'get_dependency_version',
    {
      description:
        "Look up a specific package's currently declared version in a repository's package.json, checking both dependencies and devDependencies.",
      inputSchema: z.object({
        repoPath: z
          .string()
          .describe('Absolute path to the repository root on disk'),
        packageName: z
          .string()
          .describe('The npm package name to look up, e.g. "react"')
      })
    },
    async ({ repoPath, packageName }) => {
        const result = lookupDependencyVersion(repoPath, packageName);
  
        if (!result.ok) {
          return {
            content: [{ type: 'text', text: result.error }],
            isError: true
          };
        }
  
        return {
          content: [
            { type: 'text', text: JSON.stringify(result.data, null, 2) }
          ]
        };
      }
    );

  
    server.registerTool(
        'summarize_upgrade_investigation',
        {
          description:
            'Produce a structured summary of a dependency upgrade investigation: repository info, package manager, lockfile, the target dependency, its current version, and the requested upgrade target.',
          inputSchema: z.object({
            repoPath: z
              .string()
              .describe('Absolute path to the repository root on disk'),
            packageName: z
              .string()
              .describe('The npm package name to investigate, e.g. "react"'),
            requestedTarget: z
              .string()
              .describe(
                'The requested upgrade target version or range, e.g. "19.x" or "19.0.0"'
              )
          })
        },
        async ({ repoPath, packageName, requestedTarget }) => {
          const repoResult = inspectRepository(repoPath);
    
          if (!repoResult.ok) {
            return {
              content: [{ type: 'text', text: repoResult.error }],
              isError: true
            };
          }
    
          const depResult = lookupDependencyVersion(repoPath, packageName);
    
          if (!depResult.ok) {
            return {
              content: [{ type: 'text', text: depResult.error }],
              isError: true
            };
          }
    
          const summary = {
            repository: repoResult.data.repoPath,
            packageManager: repoResult.data.packageManager,
            lockfile: repoResult.data.hasLockfile
              ? 'package-lock.json detected'
              : 'No lockfile detected',
            dependency: depResult.data.packageName,
            dependencyType: depResult.data.dependencyType,
            currentVersion: depResult.data.currentVersion,
            requestedTarget,
            status: 'Ready for upgrade investigation'
          };
    
          return {
            content: [{ type: 'text', text: JSON.stringify(summary, null, 2) }]
          };
        }
      );

  return server;
}

const PORT = process.env.PORT ? Number(process.env.PORT) : 4000;

const app = createMcpExpressApp();

app.post('/mcp', async (req, res) => {
  const server = createServer();
  const transport = new NodeStreamableHTTPServerTransport({
    sessionIdGenerator: undefined
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

app.get('/mcp', (_req, res) => {
  res.status(405).json({
    jsonrpc: '2.0',
    error: { code: -32000, message: 'Method not allowed.' },
    id: null
  });
});

app.delete('/mcp', (_req, res) => {
  res.status(405).json({
    jsonrpc: '2.0',
    error: { code: -32000, message: 'Method not allowed.' },
    id: null
  });
});

app.listen(PORT, () => {
  console.log(
    `UpgradeGuard repo-tooling MCP server listening on http://localhost:${PORT}/mcp`
  );
});