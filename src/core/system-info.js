const os = require("os");
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const chalk = require("chalk");

/**
 * System Info — detects machine capabilities for auto-scaling decisions.
 *
 * Detects: CPU cores, total/free memory, disk space, platform,
 * container environment (Docker/K8s), cloud provider hints.
 */

function detect() {
  const cpus = os.cpus();
  const totalMemGB = Math.round(os.totalmem() / 1024 / 1024 / 1024 * 10) / 10;
  const freeMemGB = Math.round(os.freemem() / 1024 / 1024 / 1024 * 10) / 10;
  const disk = getDiskInfo();

  const info = {
    platform: os.platform(),
    arch: os.arch(),
    hostname: os.hostname(),
    nodeVersion: process.version,

    cpu: {
      cores: cpus.length,
      model: cpus[0]?.model?.trim() || "unknown",
      speed: cpus[0]?.speed || 0,
      // Usable workers = cores - 1 (reserve 1 for master)
      workers: Math.max(1, cpus.length - 1),
    },

    memory: {
      totalGB: totalMemGB,
      freeGB: freeMemGB,
      usedPercent: Math.round((1 - os.freemem() / os.totalmem()) * 100),
    },

    disk: {
      totalGB: disk.totalGB,
      freeGB: disk.freeGB,
      usedPercent: disk.usedPercent,
    },

    environment: detectEnvironment(),

    // Auto-scaling recommendation
    recommended: {
      workers: recommendWorkers(cpus.length, totalMemGB),
      maxMemoryPerWorkerMB: Math.floor((totalMemGB * 1024 * 0.7) / Math.max(1, cpus.length - 1)),
    },
  };

  return info;
}

function getDiskInfo() {
  try {
    if (os.platform() === "win32") {
      const drive = process.cwd().slice(0, 2);
      const output = execSync(`wmic logicaldisk where "DeviceID='${drive}'" get FreeSpace,Size /VALUE`, { encoding: "utf-8", timeout: 3000 });
      const free = parseInt((output.match(/FreeSpace=(\d+)/) || [])[1] || "0", 10);
      const total = parseInt((output.match(/Size=(\d+)/) || [])[1] || "0", 10);
      return {
        totalGB: Math.round(total / 1024 / 1024 / 1024 * 10) / 10,
        freeGB: Math.round(free / 1024 / 1024 / 1024 * 10) / 10,
        usedPercent: total > 0 ? Math.round((1 - free / total) * 100) : 0,
      };
    } else {
      const output = execSync("df -BG / | tail -1", { encoding: "utf-8", timeout: 3000 });
      const parts = output.trim().split(/\s+/);
      return {
        totalGB: parseInt(parts[1], 10) || 0,
        freeGB: parseInt(parts[3], 10) || 0,
        usedPercent: parseInt(parts[4], 10) || 0,
      };
    }
  } catch {
    return { totalGB: 0, freeGB: 0, usedPercent: 0 };
  }
}

function detectEnvironment() {
  const env = {
    type: "bare-metal",
    docker: false,
    kubernetes: false,
    cloud: null,
  };

  // Docker detection
  if (fs.existsSync("/.dockerenv") || (process.env.DOCKER_CONTAINER === "true")) {
    env.type = "docker";
    env.docker = true;
  }

  // Kubernetes detection
  if (process.env.KUBERNETES_SERVICE_HOST || fs.existsSync("/var/run/secrets/kubernetes.io")) {
    env.type = "kubernetes";
    env.kubernetes = true;
    env.docker = true;
  }

  // Cloud hints
  if (process.env.AWS_REGION || process.env.AWS_EXECUTION_ENV) env.cloud = "aws";
  else if (process.env.GOOGLE_CLOUD_PROJECT || process.env.GCP_PROJECT) env.cloud = "gcp";
  else if (process.env.AZURE_FUNCTIONS_ENVIRONMENT || process.env.WEBSITE_SITE_NAME) env.cloud = "azure";
  else if (process.env.RAILWAY_ENVIRONMENT) env.cloud = "railway";
  else if (process.env.FLY_APP_NAME) env.cloud = "fly";
  else if (process.env.RENDER) env.cloud = "render";
  else if (process.env.VERCEL) env.cloud = "vercel";
  else if (process.env.HEROKU_APP_NAME || process.env.DYNO) env.cloud = "heroku";

  return env;
}

function recommendWorkers(cores, memGB) {
  // 1 core or <1GB: can't cluster
  if (cores <= 1 || memGB < 1) return 1;
  // 2 cores: 2 workers (master is lightweight, both cores serve requests)
  if (cores === 2) return 2;
  // 3-4 cores: cores - 1
  if (cores <= 4) return cores - 1;
  // 5-8 cores: cores - 1 but cap at 6
  if (cores <= 8) return Math.min(cores - 1, 6);
  // 9+ cores: half the cores (diminishing returns per worker)
  return Math.min(Math.floor(cores / 2), 16);
}

/**
 * Log system info on startup.
 */
function logSystemInfo(info) {
  console.log(chalk.gray(`  💻 System: ${info.platform}/${info.arch} — ${info.cpu.cores} cores, ${info.memory.totalGB}GB RAM, ${info.disk.freeGB}GB free disk`));
  console.log(chalk.gray(`  💻 CPU: ${info.cpu.model.slice(0, 50)}`));
  console.log(chalk.gray(`  💻 Env: ${info.environment.type}${info.environment.cloud ? ` (${info.environment.cloud})` : ""}`));
  console.log(chalk.gray(`  💻 Recommended: ${info.recommended.workers} workers, ${info.recommended.maxMemoryPerWorkerMB}MB/worker`));
}

module.exports = { detect, logSystemInfo, recommendWorkers };
