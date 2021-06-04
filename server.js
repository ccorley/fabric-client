'use strict'

const express = require('express')
const https = require('https')
const bodyParser = require('body-parser')
const HTTPStatus = require('http-status-codes')
const path = require('path')
const fs = require('fs')
const { Gateway, Wallets } = require('fabric-network')
const app = express()
var cfg
var contract

app.use(bodyParser.json())

// cert and key for HTTPS
const options = {
    key: fs.readFileSync(path.resolve(__dirname, 'conf/certs/server-key.pem')),
    cert: fs.readFileSync(path.resolve(__dirname, 'conf/certs/server-cert.pem'))
};

setup().then(() => {
    var server = https.createServer(options, app)
    server.listen(cfg.port, () => {
        console.log("Server listening on port : " + cfg.port)
    })
})

// GET the record identified by the id in the request query
app.get('/patient', (req, res) => {
    req.body = { "fcn": "queryPatient", "args": [ req.query.id ] }
    sendTransaction(req, res)
})

// POST the record using the JSON in the request body
app.post('/patient', (req, res) => {
    req.body = { "fcn": "addPatient", "args": [ req.body.id, req.body] }
    sendTransaction(req, res)
})

// PUT the record using the JSON in the request body
app.put('/patient', (req, res) => {
    req.body = { "fcn": "replacePatient", "args": [ req.body.id, req.body] }
    sendTransaction(req, res)
})

// PATCH the record using the JSON in the request body
app.patch('/patient', (req, res) => {
    req.body = { "fcn": "updatePatient", "args": [ req.body.id, req.body] }
    sendTransaction(req, res)
})

/**
  * Read the configuration file and create the connection to the blockchain.
  */
async function setup () {
    try {
        // Get config parameters
        cfg = JSON.parse(fs.readFileSync(path.resolve(__dirname, 'conf/config.json')))
        console.log('Read the JSON config file')

        // Get the connection profile
        const profile = JSON.parse(fs.readFileSync(path.resolve(__dirname, cfg.connection_profile)))

        // Create a new file system wallet for managing identities
        const walletPath = path.resolve(__dirname, cfg.wallet_location)
        const wallet = await Wallets.newFileSystemWallet(walletPath)
        console.log(`Wallet path: ${walletPath}`)

        // Check to see if we've already enrolled the user
        const identity = await wallet.get(cfg.user)
        if (!identity) {
            console.log(`An identity for the user ${cfg.user} does not exist in the wallet`)
            console.log('Run the registerUser.js application before retrying')
            return;
        }

        // Create a new gateway for connecting to our peer node
        const use_disc = process.env.INITIALIZE_WITH_DISCOVERY || cfg.use_discovery
        const as_local = process.env.DISCOVERY_AS_LOCALHOST || cfg.as_local_host
        const enabled = true ? use_disc === 'true' : false
        const asLocalhost = true ? as_local === 'true' : false
        console.log(`Discovery enabled = ${enabled} asLocalhost = ${asLocalhost}`)
        const gateway = new Gateway()
        await gateway.connect(profile, { wallet, identity: cfg.user, discovery: { enabled, asLocalhost } })

        // Get the network (channel) our contract is deployed to
        const network = await gateway.getNetwork(cfg.channel)

        // Get the contract from the network
        contract = network.getContract(cfg.contract)
        console.log('Connected to the blockchain')
    } catch (error) {
        console.error(`Failed to set up the fabric client: ${error}`)
        process.exit(1)
    }
}

/**
  * Send the transaction. Since all API calls are invokes, the steps are the 
  * same for get, post, put, patch.
  */
async function sendTransaction (req, res) {
    const { fcn } = req.body
    let { args } = req.body

    try {
        // Allow JSON objects in REST body by stringifying here
        args = stringifyArrayValues(args)

        // Create the transaction
        const transaction = contract.createTransaction(fcn)

        // Submit the transaction
        transaction.submit(...args)
        .then(respbytes => {
            let response = ''
            if (respbytes && respbytes.length > 0) response = JSON.parse(respbytes.toString())
            res.status(HTTPStatus.OK).send(response)
            console.log('Submitted '+fcn+' transaction')
        })
        .catch(error => {
            // If we couldn't submit, assume it's a problem with the request => 400
            // We could differentiate the errors, as 502 Bad Gateway is also a possibility.
            console.log(error)
            res.status(HTTPStatus.BAD_REQUEST).send(JSON.stringify(error.message))
        })
    } catch (error) {
        // Any other problem => 500
        res.status(HTTPStatus.INTERNAL_SERVER_ERROR).send(JSON.stringify(error.message))
    }
}

/**
  * args needs to be an array of strings, but it is easier to work with JSON.
  * Allow JSON payloads by stringifying each element of the args array, if necessary.
  */
function stringifyArrayValues (args) {
    let newArray = []
    args.forEach(item => {
        typeof item === 'string' ? newArray.push(item) : newArray.push(JSON.stringify(item))
    })
    return newArray
}
