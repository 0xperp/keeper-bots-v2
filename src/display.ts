import fs from 'fs';
import { program, Option } from 'commander';

import { Connection, Commitment, Keypair, PublicKey } from '@solana/web3.js';

import {
	Token,
	TOKEN_PROGRAM_ID,
	ASSOCIATED_TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import {
	getVariant,
	BulkAccountLoader,
	DriftClient,
	User,
	initialize,
	Wallet,
	DriftEnv,
	EventSubscriber,
	SlotSubscriber,
	convertToNumber,
	QUOTE_PRECISION,
	SPOT_MARKET_BALANCE_PRECISION,
	SpotMarkets,
	PerpMarkets,
	BN,
	BASE_PRECISION,
	getSignedTokenAmount,
	TokenFaucet,
} from '@drift-labs/sdk';

import { logger, setLogLevel } from './logger';
import { constants } from './types';
import {
	getOrCreateAssociatedTokenAccount,
	TOKEN_FAUCET_PROGRAM_ID,
} from './utils';

require('dotenv').config();
const driftEnv = process.env.ENV as DriftEnv;
//@ts-ignore
const sdkConfig = initialize({ env: process.env.ENV });

const stateCommitment: Commitment = 'confirmed';

program
	.option('-d, --dry-run', 'Dry run, do not send transactions on chain')
	.option(
		'--init-user',
		'calls clearingHouse.initializeUserAccount if no user account exists'
	)
	.option('--filler', 'Enable filler bot')
	.option('--spot-filler', 'Enable spot filler bot')
	.option('--trigger', 'Enable trigger bot')
	.option('--jit-maker', 'Enable JIT auction maker bot')
	.option('--floating-maker', 'Enable floating maker bot')
	.option('--liquidator', 'Enable liquidator bot')
	.option('--pnl-settler', 'Enable PnL settler bot')
	.option('--cancel-open-orders', 'Cancel open orders on startup')
	.option('--close-open-positions', 'Close all open positions')
	.option('--test-liveness', 'Purposefully fail liveness test after 1 minute')
	.option(
		'--force-deposit <number>',
		'Force deposit this amount of USDC to collateral account, the program will end after the deposit transaction is sent'
	)
	.option('--metrics <number>', 'Enable Prometheus metric scraper')
	.option(
		'--vault <bool>',
		'Load private key from vault in the `secret` mount with the key `pk`'
	)
	.addOption(
		new Option(
			'-p, --private-key <string>',
			'private key, supports path to id.json, or list of comma separate numbers'
		).env('KEEPER_PRIVATE_KEY')
	)
	.option('--debug', 'Enable debug logging')
	.parse();

const opts = program.opts();
setLogLevel(opts.debug ? 'debug' : 'info');

logger.info(`Dry run: ${!!opts.dry},\n\
FillerBot enabled: ${!!opts.filler},\n\
SpotFillerBot enabled: ${!!opts.spotFiller},\n\
TriggerBot enabled: ${!!opts.trigger},\n\
JitMakerBot enabled: ${!!opts.jitMaker},\n\
PnlSettler enabled: ${!!opts.pnlSettler},\n\
`);

export async function getWallet(): Promise<Wallet> {
	let privateKey;
	if (opts.vault) {
		await fetch(process.env.VAULT_ENDPOINT, {
			method: 'GET',
			headers: {
				'X-Vault-Token': process.env.VAULT_TOKEN,
				'X-Vault-Namespace': 'admin',
			},
		})
			.then((response) => response.json())
			.then((response) => (privateKey = response.data.data.pk));
	} else {
		privateKey = process.env.KEEPER_PRIVATE_KEY;
	}

	if (!privateKey) {
		throw new Error(
			'Must set environment variable KEEPER_PRIVATE_KEY with the path to a id.json or a list of commma separated numbers or load via vault and use the --vault flag'
		);
	}

	// try to load privateKey as a filepath
	let loadedKey: Uint8Array;
	if (fs.existsSync(privateKey)) {
		logger.info(`loading private key from ${privateKey}`);
		loadedKey = new Uint8Array(
			JSON.parse(fs.readFileSync(privateKey).toString())
		);
	} else {
		logger.info(`loading private key as comma separated numbers`);
		loadedKey = Uint8Array.from(
			privateKey.split(',').map((val) => Number(val))
		);
	}

	const keypair = Keypair.fromSecretKey(Uint8Array.from(loadedKey));
	return new Wallet(keypair);
}

const endpoint = process.env.ENDPOINT;
logger.info(`RPC endpoint: ${endpoint}`);

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function printUserAccountStats(clearingHouseUser: User) {
	const freeCollateral = clearingHouseUser.getFreeCollateral();
	logger.info(
		`User free collateral: $${convertToNumber(
			freeCollateral,
			QUOTE_PRECISION
		)}:`
	);

	logger.info(
		`CHUser unrealized funding PnL: ${convertToNumber(
			clearingHouseUser.getUnrealizedFundingPNL(),
			QUOTE_PRECISION
		)}`
	);
	logger.info(
		`CHUser unrealized PnL:         ${convertToNumber(
			clearingHouseUser.getUnrealizedPNL(),
			QUOTE_PRECISION
		)}`
	);
}

function printOpenPositions(clearingHouseUser: User) {
	logger.info('Open Perp Positions:');
	for (const p of clearingHouseUser.getUserAccount().perpPositions) {
		if (p.baseAssetAmount.isZero()) {
			continue;
		}
		const market = PerpMarkets[driftEnv][p.marketIndex];
		console.log(`[${market.symbol}]`);
		console.log(
			` . baseAssetAmount:  ${convertToNumber(
				p.baseAssetAmount,
				BASE_PRECISION
			).toString()}`
		);
		console.log(
			` . quoteAssetAmount: ${convertToNumber(
				p.quoteAssetAmount,
				QUOTE_PRECISION
			).toString()}`
		);
		console.log(
			` . quoteEntryAmount: ${convertToNumber(
				p.quoteEntryAmount,
				QUOTE_PRECISION
			).toString()}`
		);

		console.log(
			` . lastCumulativeFundingRate: ${convertToNumber(
				p.lastCumulativeFundingRate,
				new BN(10).pow(new BN(14))
			)}`
		);
		console.log(
			` . openOrders: ${p.openOrders.toString()}, openBids: ${convertToNumber(
				p.openBids,
				BASE_PRECISION
			)}, openAsks: ${convertToNumber(p.openAsks, BASE_PRECISION)}`
		);
	}

	logger.info('Open Spot Positions:');
	for (const p of clearingHouseUser.getUserAccount().spotPositions) {
		if (p.scaledBalance.isZero()) {
			continue;
		}
		const market = SpotMarkets[driftEnv][p.marketIndex];
		console.log(`[${market.symbol}]`);
		console.log(
			` . baseAssetAmount:  ${convertToNumber(
				getSignedTokenAmount(p.scaledBalance, p.balanceType),
				SPOT_MARKET_BALANCE_PRECISION
			).toString()}`
		);
		console.log(` . balanceType: ${getVariant(p.balanceType)}`);
		console.log(
			` . openOrders: ${p.openOrders.toString()}, openBids: ${convertToNumber(
				p.openBids,
				SPOT_MARKET_BALANCE_PRECISION
			)}, openAsks: ${convertToNumber(
				p.openAsks,
				SPOT_MARKET_BALANCE_PRECISION
			)}`
		);
	}
}

const runBot = async () => {
	const wallet = await getWallet();
	const clearingHousePublicKey = new PublicKey(sdkConfig.DRIFT_PROGRAM_ID);

	const connection = new Connection(endpoint, stateCommitment);

	const bulkAccountLoader = new BulkAccountLoader(
		connection,
		stateCommitment,
		1000
	);
	const clearingHouse = new DriftClient({
		connection,
		wallet,
		programID: clearingHousePublicKey,
		accountSubscription: {
			type: 'polling',
			accountLoader: bulkAccountLoader,
		},
		env: driftEnv,
		userStats: true,
	});

	const eventSubscriber = new EventSubscriber(
		connection,
		clearingHouse.program,
		{
			maxTx: 8192,
			maxEventsPerType: 8192,
			orderBy: 'blockchain',
			orderDir: 'desc',
			commitment: stateCommitment,
			logProviderConfig: {
				type: 'polling',
				frequency: 1000,
				// type: 'websocket',
			},
		}
	);

	const slotSubscriber = new SlotSubscriber(connection, {});

	const lamportsBalance = await connection.getBalance(wallet.publicKey);
	logger.info(
		`ClearingHouse ProgramId: ${clearingHouse.program.programId.toBase58()}`
	);
	logger.info(`Wallet pubkey: ${wallet.publicKey.toBase58()}`);
	logger.info(` . SOL balance: ${lamportsBalance / 10 ** 9}`);
	const tokenAccount = await getOrCreateAssociatedTokenAccount(
		connection,
		new PublicKey(constants.devnet.USDCMint),
		wallet
	);
	const usdcBalance = await connection.getTokenAccountBalance(tokenAccount);
	logger.info(` . USDC balance: ${usdcBalance.value.uiAmount}`);

	await clearingHouse.subscribe();
	clearingHouse.eventEmitter.on('error', (e) => {
		logger.info('clearing house error');
		logger.error(e);
	});

	eventSubscriber.subscribe();
	await slotSubscriber.subscribe();

	if (!(await clearingHouse.getUser().exists())) {
		logger.error(`User for ${wallet.publicKey} does not exist`);
		if (opts.initUser) {
			logger.info(`Creating User for ${wallet.publicKey}`);
			const [txSig] = await clearingHouse.initializeUserAccount();
			logger.info(`Initialized user account in transaction: ${txSig}`);
		} else {
			throw new Error("Run with '--init-user' flag to initialize a User");
		}
	}

	// subscribe will fail if there is no clearing house user
	const clearingHouseUser = clearingHouse.getUser();
	while (
		!(await clearingHouse.subscribe()) ||
		!(await clearingHouseUser.subscribe()) ||
		!eventSubscriber.subscribe()
	) {
		logger.info('waiting to subscribe to ClearingHouse and User');
		await sleep(1000);
	}
	logger.info(
		`User PublicKey: ${clearingHouseUser.getUserAccountPublicKey().toBase58()}`
	);
	await clearingHouse.fetchAccounts();
	await clearingHouse.getUser().fetchAccounts();

	printUserAccountStats(clearingHouseUser);

	if (opts.closeOpenPositions) {
		logger.info(`Closing open perp positions`);
		let closedPerps = 0;
		for await (const p of clearingHouseUser.getUserAccount().perpPositions) {
			if (p.baseAssetAmount.isZero()) {
				logger.info(`no position on market: ${p.marketIndex}`);
				continue;
			}
			logger.info(`closing position on ${p.marketIndex}`);
			logger.info(` . ${await clearingHouse.closePosition(p.marketIndex)}`);
			closedPerps++;
		}
		console.log(`Closed ${closedPerps} spot positions`);

		let closedSpots = 0;
		for await (const p of clearingHouseUser.getUserAccount().spotPositions) {
			if (p.scaledBalance.isZero()) {
				logger.info(`no position on market: ${p.marketIndex}`);
				continue;
			}
			logger.info(`closing position on ${p.marketIndex}`);
			logger.info(` . ${await clearingHouse.closePosition(p.marketIndex)}`);
			closedSpots++;
		}
		console.log(`Closed ${closedSpots} spot positions`);
	}

	// check that user has collateral
	const freeCollateral = clearingHouseUser.getFreeCollateral();
	if (freeCollateral.isZero() && opts.jitMaker && !opts.forceDeposit) {
		throw new Error(
			`No collateral in account, collateral is required to run JitMakerBot, run with --force-deposit flag to deposit collateral`
		);
	}
	if (opts.forceDeposit) {
		logger.info(
			`Depositing (${new BN(
				opts.forceDeposit
			).toString()} USDC to collateral account)`
		);

		if (opts.forceDeposit < 0) {
			logger.error(`Deposit amount must be greater than 0`);
			throw new Error('Deposit amount must be greater than 0');
		}

		const mint = SpotMarkets[driftEnv][0].mint; // TODO: are index 0 always USDC???, support other collaterals

		const ata = await Token.getAssociatedTokenAddress(
			ASSOCIATED_TOKEN_PROGRAM_ID,
			TOKEN_PROGRAM_ID,
			mint,
			wallet.publicKey
		);

		const amount = new BN(opts.forceDeposit).mul(QUOTE_PRECISION);

		if (driftEnv == 'devnet') {
			const tokenFaucet = new TokenFaucet(
				connection,
				wallet,
				TOKEN_FAUCET_PROGRAM_ID,
				mint,
				opts
			);
			await tokenFaucet.mintToUser(ata, amount);
		}

		const tx = await clearingHouse.deposit(
			amount,
			0, // USDC bank
			ata
		);
		logger.info(`Deposit transaction: ${tx}`);
		logger.info(`exiting...run again without --force-deposit flag`);
		return;
	}

	// print user orders
	logger.info('');
	logger.info(
		`Open orders: ${clearingHouseUser.getUserAccount().orders.length}`
	);
	const ordersToCancel: Array<number> = [];
	for (const order of clearingHouseUser.getUserAccount().orders) {
		if (order.baseAssetAmount.isZero()) {
			continue;
		}
		ordersToCancel.push(order.orderId);
	}
	if (opts.cancelOpenOrders) {
		for (const order of ordersToCancel) {
			logger.info(`Cancelling open order ${order.toString()}`);
			await clearingHouse.cancelOrder(order);
		}
	}

	printOpenPositions(clearingHouseUser);
	process.exit(0);
};

runBot();
