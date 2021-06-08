'use strict'

const express = require('express')
const https = require('https')
const bodyParser = require('body-parser')
const HTTPStatus = require('http-status-codes')
const path = require('path')
const fs = require('fs')
const FabricCAServices = require('fabric-ca-client')
const { Gateway, Wallets } = require('fabric-network')
const app = express()
var cfg, profile
var contract, wallet

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
            console.log(`Submitted ${fcn} transaction`)
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
  * Read the configuration file and create the connection to the blockchain.
  */
async function setup () {
    try {
        // Get config parameters
        cfg = JSON.parse(fs.readFileSync(path.resolve(__dirname, 'conf/config.json')))
        console.log('Read the JSON config file')

        // Get the connection profile
        profile = JSON.parse(fs.readFileSync(path.resolve(__dirname, cfg.connection_profile)))

        // Create a new file system wallet for managing identities
        const walletPath = path.resolve(__dirname, cfg.wallet_location)
        wallet = await Wallets.newFileSystemWallet(walletPath)
        console.log(`Wallet path: ${walletPath}`)

        // Enroll an admin, if configured (recommended for dev/test only)
        if (cfg.enroll_admin === 'true') {
            console.log(`Enrolling admin user: ${cfg.admin_name}`)
            await enrollAdmin()
        }

        // Register a user, if configured (recommended for dev/test only)
        if (cfg.register_user === 'true') {
            console.log(`Registering user: ${cfg.user_name}`)
            await registerUser()
        }

        // Make sure we have a registered user
        const identity = await wallet.get(cfg.user_name)
        if (!identity) {
            console.log(`An identity for the user ${cfg.user_name} does not exist in the wallet`)
            process.exit(1)
        }

        // Create a new gateway for connecting to our peer node
        const use_disc = process.env.INITIALIZE_WITH_DISCOVERY || cfg.use_discovery
        const as_local = process.env.DISCOVERY_AS_LOCALHOST || cfg.as_local_host
        const enabled = true ? use_disc === 'true' : false
        const asLocalhost = true ? as_local === 'true' : false
        console.log(`Discovery enabled = ${enabled} asLocalhost = ${asLocalhost}`)
        const gateway = new Gateway()
        await gateway.connect(profile, { wallet, identity: cfg.user_name, discovery: { enabled, asLocalhost } })

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
  * Enroll an admin.
  */
async function enrollAdmin() {
    try {
        // Create a new CA client for interacting with the CA.
        const caInfo = profile.certificateAuthorities[cfg.certificate_authority]
        const caTLSCACerts = caInfo.tlsCACerts.pem
        const ca = new FabricCAServices(caInfo.url, { trustedRoots: caTLSCACerts, verify: false }, caInfo.caName)

        // Check to see if we've already enrolled the admin user.
        const identity = await wallet.get(cfg.admin_name)
        if (identity) {
            console.log(`An identity for the admin user ${cfg.admin_name} already exists in the wallet - no admin enrollment needed`)
            return
        }

        // Enroll the admin user, and import the new identity into the wallet.
        const enrollment = await ca.enroll({ enrollmentID: cfg.admin_name, enrollmentSecret: cfg.admin_pw })
        const x509Identity = {
            credentials: {
                certificate: enrollment.certificate,
                privateKey: enrollment.key.toBytes(),
            },
            mspId: cfg.msp_id,
            type: 'X.509',
        };
        await wallet.put(cfg.admin_name, x509Identity)
        console.log(`Successfully enrolled admin user ${cfg.admin_name} and imported it into the wallet`)
    } catch (error) {
        console.error(`Failed to enroll admin user ${cfg.admin_name}: ${error}`)
        process.exit(1)
    }
}

/**
  * Register a user.
  */
async function registerUser() {
    try {
        // Create a new CA client for interacting with the CA.
        const caURL = profile.certificateAuthorities[cfg.certificate_authority].url
        const ca = new FabricCAServices(caURL)

        // Check to see if we've already enrolled the user.
        const userIdentity = await wallet.get(cfg.user_name)
        if (userIdentity) {
            console.log(`An identity for the user ${cfg.user_name} already exists in the wallet - no user registration needed`)
            return
        }

        // Check to see if we've already enrolled the admin user
        const adminIdentity = await wallet.get(cfg.admin_name)
        if (!adminIdentity) {
            console.log(`An identity for the admin user ${cfg.admin_name} does not exist in the wallet`)
            process.exit(1)
        }

        // Build a user object for authenticating with the CA
        const provider = wallet.getProviderRegistry().getProvider(adminIdentity.type)
        const adminUser = await provider.getUserContext(adminIdentity, cfg.admin_name)

        // Register the user, enroll the user, and import the new identity into the wallet
        const secret = await ca.register({
            affiliation: 'org1.department1',
            enrollmentID: cfg.user_name,
            role: 'client'
        }, adminUser)
        const enrollment = await ca.enroll({
            enrollmentID: cfg.user_name,
            enrollmentSecret: secret
        })
        const x509Identity = {
            credentials: {
                certificate: enrollment.certificate,
                privateKey: enrollment.key.toBytes(),
            },
            mspId: cfg.msp_id,
            type: 'X.509',
        }
        await wallet.put(cfg.user_name, x509Identity)
        console.log(`Successfully registered and enrolled user ${cfg.user_name} and imported it into the wallet`)
    } catch (error) {
        console.error(`Failed to register user ${cfg.user_name}: ${error}`)
        process.exit(1)
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
