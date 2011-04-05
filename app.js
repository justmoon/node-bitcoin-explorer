
/**
 * Module dependencies.
 */

var express = require('express');
var winston = require('winston');
var bitcoin = require('bitcoin-p2p');
var bigint = require('bigint');

global.Util = bitcoin.Util;
global.bigint = bitcoin.bigint;

var app = module.exports = express.createServer();

var storage = new bitcoin.Storage('mongodb://localhost/bitcoin');
var node = new bitcoin.Node();
var chain = node.getBlockChain();

node.cfg.network.bootstrap = [];
node.addPeer('localhost');

node.start();

// Configuration

app.configure(function(){
	app.set('views', __dirname + '/views');
	app.set('view engine', 'ejs');
	app.use(express.bodyParser());
	app.use(express.methodOverride());
	app.use(app.router);
	app.use(express.static(__dirname + '/public'));
});

app.configure('development', function(){
	app.use(express.errorHandler({ dumpExceptions: true, showStack: true })); 
});

app.configure('production', function(){
	app.use(express.errorHandler());
});

function getOutpoints(txs, callback) {
	// If we got only one tx, wrap it so we can use the same code afterwards
	if (txs.hash) txs = [txs];

	var txList = [];
	txs.forEach(function (tx) {
		tx.ins.forEach(function (txin) {
			txList.push(txin.outpoint.hash);
		});
	});
	storage.Transaction.find({hash: {"$in": txList}}, function (err, result) {
		if (err) return callback(err);

		var txIndex = {};
		result.forEach(function (tx) {
			txIndex[tx.hash.toString('base64')] = tx;
		});

		txs.forEach(function (tx, i) {
			tx.totalIn = bigint(0);
			tx.totalOut = bigint(0);
			tx.ins.forEach(function (txin, j) {
				var op = txin.outpoint;
				var srctx = txIndex[op.hash.toString('base64')];
				if (srctx) {
					txin.source = srctx.outs[op.index];
					tx.totalIn = tx.totalIn.add(Util.valueToBigInt(txin.source.value));
				}
			});
			tx.outs.forEach(function (txout) {
				tx.totalOut = tx.totalOut.add(Util.valueToBigInt(txout.value));
			});
			if (!tx.isCoinBase()) tx.fee = tx.totalIn.sub(tx.totalOut);
		});
		callback(null);
	});
}

// Params

app.param('blockHash', function (req, res, next, hash){
	hash = new Buffer(hash, 'hex').reverse();
	chain.getBlockByHash(hash, function (err, block) {
		if (err) return next(err);

		chain.getBlockByPrev(hash, function (err, nextBlock) {
			if (err) return next(err);

			storage.Transaction.find({block: block._id}, function (err, txs) {
				if (err) return next(err);

				getOutpoints(txs, function (err) {
					if (err) return next(err);

					var totalFee = bigint(0);
					var totalOut = bigint(0);
					txs.forEach(function (tx) {
						tx.outs.forEach(function (txout) {
							totalOut = totalOut.add(Util.valueToBigInt(txout.value));
						});
						if (tx.fee) totalFee = totalFee.add(tx.fee);
					});
					block.totalFee = totalFee;
					block.totalOut = totalOut;

					req.block = block;
					req.nextBlock = nextBlock;
					req.block.txs = txs;

					next();
				});
			});
		});
	});
});

app.param('txHash', function (req, res, next, hash){
	hash = new Buffer(hash, 'hex').reverse();
	storage.Transaction.findOne({hash: hash}, function (err, tx) {
		if (err) return next(err);
		req.tx = tx;

		storage.Block.findOne({_id: tx.block}, function (err, block) {
			if (err) return next(err);
			req.block = block;

			getOutpoints(tx, function (err) {
				if (err) return next(err);

				next();
			});
		});
	});
});

app.param('addrBase58', function (req, res, next, addr){
	var pubKeyHash = Util.addressToPubKeyHash(addr);
	req.pubKeyHash = pubKeyHash;
	storage.Account.findOne({pubKeyHash: pubKeyHash.toString('base64')}, function (err, account) {
		if (err) return next(err);

		if (!account) return next(new Error("Address "+addr+" not found!"));

		var txList = [];
		account.txs.forEach(function (txRef) {
			txList.push(txRef.tx);
		});

		storage.Transaction.find({hash: {$in: txList}}).exec(function (err, txs) {
			if (err) return next(err);

			var blockIds = [];
			txs.forEach(function (tx) {
				if (blockIds.indexOf(tx.block) == -1) blockIds.push(tx.block);
			});

			storage.Block.find({_id: {$in: blockIds}}, function (err, blocks) {
				if (err) return next(err);

				getOutpoints(txs, function (err) {
					if (err) return next(err);

					var blkObj = {};
					blocks.forEach(function (block) {
						blkObj[block._id.toString()] = block;
					});
					var txsObj = {};
					txs.forEach(function (tx) {
						tx.blockObj = blkObj[tx.block.toString()];
						txsObj[tx.hash.toString('base64')] = tx;
					});
					req.txsObj = txsObj;

					var receivedCount = 0;
					var receivedAmount = bigint(0);
					var sentCount = 0;
					var sentAmount = bigint(0);

					txOutsObj = {};
					account.txs.forEach(function (txRef, index) {
						var tx = txsObj[txRef.tx];
						for (var i = 0; i < tx.outs.length; i++) {
							var txout = tx.outs[i];
							var script = txout.getScript();

							var outPubKey = script.simpleOutPubKeyHash();

							if (outPubKey && pubKeyHash.compare(outPubKey) == 0) {
								receivedCount++;
								var outIndex =
									tx.hash.toString('base64')+":"+
									i;
								txOutsObj[outIndex] = txout;

								receivedAmount = receivedAmount.add(Util.valueToBigInt(txout.value));

								tx.myOut = txout;
							}
						};
					});

					txs.forEach(function (tx, index) {
						if (tx.isCoinBase()) return;

						tx.ins.forEach(function (txin, j) {
							var script = txin.getScript();

							var inPubKey = Util.sha256ripe160(script.simpleInPubKey());

							if (inPubKey && pubKeyHash.compare(inPubKey) == 0) {
								sentCount++;
								var outIndex =
									txin.outpoint.hash.toString('base64')+":"+
									txin.outpoint.index;

								if (!txOutsObj[outIndex]) {
									winston.warn('Outgoing transaction is missing matching incoming transaction.');
									return;
								}
								txOutsObj[outIndex].spent = {
									txin: txin,
									tx: tx
								};

								sentAmount = sentAmount.add(Util.valueToBigInt(txin.source.value));

								tx.myIn = txin;
							}
						});
					});

					// Calculate the current available balance
					var totalAvailable = bigint(0);
					for (var i in txOutsObj) {
						if (!txOutsObj[i].spent) {
							totalAvailable = totalAvailable.add(Util.valueToBigInt(txOutsObj[i].value));
						}
					}

					// Bring txs into correct order
					txs = account.txs.map(function (txRef) {
						return txsObj[txRef.tx];
					});

					account.totalAvailable = totalAvailable;
					account.receivedCount = receivedCount;
					account.receivedAmount = receivedAmount;
					account.sentCount = sentCount;
					account.sentAmount = sentAmount;

					req.account = account;
					req.txs = txs;
					req.txOutsObj = txOutsObj;
					next();
				});
			});
		});
	});
});

// Routes

app.get('/', function(req, res){
	storage.Block.find().sort('height', -1).limit(15).exec(function (err, rows) {
		if (err) return next(err);
		res.render('index', {
			title: 'Home - Bitcoin Explorer',
			latestBlocks: rows
		});
	});
});

app.get('/block/:blockHash', function (req, res) {
	res.render('block', {
		title: 'Block '+req.block.height+' - Bitcoin Explorer',
		block: req.block,
		nextBlock: req.nextBlock,
		totalAmount: req.totalAmount,
		hexDifficulty: bigint(req.block.bits).toString(16)
	});
});

app.get('/tx/:txHash', function (req, res) {
	var totalOut = bigint(0);
	req.tx.outs.forEach(function (txout) {
		totalOut = totalOut.add(Util.valueToBigInt(txout.value));
	});
	res.render('transaction', {
		title: 'Tx '+Util.formatHashAlt(req.tx.hash)+'... - Bitcoin Explorer',
		tx: req.tx,
		block: req.block,
		totalOut: totalOut
	});
});

app.get('/address/:addrBase58', function (req, res) {
	res.render('address', {
		title: 'Address '+(req.params.addrBase58)+' - Bitcoin Explorer',
		address: req.params.addrBase58,
		pubKeyHash: req.pubKeyHash,
		account: req.account,
		txs: req.txs,
		txOutsObj: req.txOutsObj
	});
});

// Only listen on $ node app.js

if (!module.parent) {
	app.listen(3000);
	winston.info("Express server listening on port " + app.address().port);
}
