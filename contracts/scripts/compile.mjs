import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import process from "node:process";
import { join } from "node:path";
import solc from "solc";

const sourceNames = ["RescueRouter.sol", "MockNativeUSDC.sol"];
const sources = Object.fromEntries(sourceNames.map((name) => [name, {
  content: readFileSync(join(process.cwd(), "contracts", "src", name), "utf8")
}]));
const result = JSON.parse(solc.compile(JSON.stringify({
  language: "Solidity",
  sources,
  settings: {
    optimizer: { enabled: true, runs: 200 },
    evmVersion: "shanghai",
    outputSelection: { "*": { "*": ["abi", "evm.bytecode.object", "evm.deployedBytecode.object"] } }
  }
})));
const errors = result.errors?.filter((entry) => entry.severity === "error") ?? [];
if (errors.length) throw new Error(errors.map((entry) => entry.formattedMessage).join("\n"));

const outputDir = join(process.cwd(), "dist", "contracts");
mkdirSync(outputDir, { recursive: true });
for (const [fileName, contracts] of Object.entries(result.contracts)) {
  for (const [contractName, contract] of Object.entries(contracts)) {
    writeFileSync(join(outputDir, `${contractName}.json`), JSON.stringify({
      contractName,
      compilerVersion: solc.version(),
      abi: contract.abi,
      bytecode: `0x${contract.evm.bytecode.object}`,
      deployedBytecode: `0x${contract.evm.deployedBytecode.object}`,
      source: fileName
    }, null, 2));
  }
}
process.stdout.write(`Compiled ${Object.values(result.contracts).reduce((total, contracts) => total + Object.keys(contracts).length, 0)} Solidity contracts with ${solc.version()}\n`);
