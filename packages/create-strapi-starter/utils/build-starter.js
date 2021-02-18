'use strict';

const { resolve, join } = require('path');
const os = require('os');
const fse = require('fs-extra');
const fetch = require('node-fetch');
const chalk = require('chalk');
const tar = require('tar');

const generateNewApp = require('strapi-generate-new');
const GitUrlParse = require('git-url-parse');
const ora = require('ora');

const {
  runInstall,
  runApp,
  setupStarter,
  initGit,
  createInitialGitCommit,
} = require('./child-process');

function getRepoInfo(starterUrl) {
  const repoInfo = GitUrlParse(starterUrl);
  const { name, full_name, ref } = repoInfo;

  return {
    name,
    full_name,
    ref,
  };
}

/**
 * @param  {string} starterUrl Github url for strapi starter
 * @param  {string} tmpDir Path to temporary directory
 */
async function downloadGithubRepo(starterUrl, tmpDir) {
  const { name, full_name, ref } = getRepoInfo(starterUrl);

  // TODO: Consider case for 'master'
  const branch = ref ? ref : 'main';

  // Download from GitHub
  const codeload = `https://codeload.github.com/${full_name}/tar.gz/${branch}`;
  const response = await fetch(codeload);
  if (!response.ok) {
    throw Error(`Could not download the ${chalk.green(`${name}`)} repository`);
  }

  await new Promise(resolve => {
    response.body.pipe(tar.extract({ strip: 1, cwd: tmpDir })).on('close', resolve);
  });
}

/**
 * @param  {string} filePath Path to starter.json file
 */
function readStarterJson(filePath) {
  const data = fse.readFileSync(filePath);
  return JSON.parse(data);
}

/**
 * @param  {string} rootPath Path to the project directory
 * @param  {string} projectName Name of the project
 */
function initPackageJson(rootPath, projectName) {
  fse.writeJson(join(rootPath, 'package.json'), {
    name: projectName,
    scripts: {
      'dev:backend': `cd backend && yarn develop`,
      'dev:frontend': `wait-on http://localhost:1337/admin && cd frontend && yarn develop --open`,
      develop: 'concurrently "yarn dev:backend" "yarn dev:frontend"',
    },
  });
}

module.exports = async function buildStarter(projectName, program) {
  const starterUrl = program.args[1];

  // Create temporary directory for starter
  const tmpDir = await fse.mkdtemp(join(os.tmpdir(), 'strapi-'));

  // Download the starter inside tmpDir
  // Fetch repo info
  const { full_name } = getRepoInfo(starterUrl);
  // Download repo inside tmp dir
  try {
    await downloadGithubRepo(starterUrl, tmpDir);
  } catch (err) {
    throw Error(`Could not download ${chalk.yellow(`${full_name}`)} repository.`);
  }

  // Read starter package json for template url
  const starterTemplate = readStarterJson(join(tmpDir, 'starter.json'));

  // Project directory
  const rootPath = resolve(projectName);

  // Copy the downloaded frontend folder to the project folder
  await fse.copy(join(tmpDir, 'frontend'), join(rootPath, 'frontend'), {
    overwrite: true,
    recursive: true,
  });

  // Delete temporary directory
  await fse.remove(tmpDir);

  console.log(`Creating Strapi starter frontend at ${chalk.green(`${rootPath}/frontend`)}.`);

  // Install frontend dependencies
  console.log(`Installing ${chalk.yellow(full_name)} starter`);

  const installPrefix = chalk.yellow('Installing dependencies:');
  const loader = ora(installPrefix).start();
  const logInstall = (chunk = '') => {
    loader.text = `${installPrefix} ${chunk
      .toString()
      .split('\n')
      .join(' ')}`;
  };

  const runner = runInstall(join(rootPath, 'frontend'));
  runner.stdout.on('data', logInstall);
  runner.stderr.on('data', logInstall);
  await runner;

  loader.stop();
  console.log(`Dependencies installed ${chalk.green('successfully')}.`);

  // Set the template argument to template specified in starter json
  program.template = starterTemplate.template;
  // Don't run the application
  program.run = false;
  // Use quickstart
  program.quickstart = true;
  // Create strapi app using the template
  await generateNewApp(join(projectName, 'backend'), program);

  // Setup monorepo
  initPackageJson(rootPath, projectName);

  loader.start(`Setting up the starter`);

  // Add gitignore
  try {
    const gitignore = join(__dirname, '..', 'resources', 'gitignore');
    await fse.copy(gitignore, join(rootPath, '.gitignore'));
  } catch (err) {
    console.error(err);
  }

  await setupStarter(rootPath);
  await initGit(rootPath);
  await createInitialGitCommit(rootPath);

  loader.stop();

  console.log(chalk.green('Starting the app'));
  await runApp(rootPath);
};
