//	A Simple script that syncronizes a folder between different computers on a
//	network. Possible terrible unsafe, I uses it to sync Open-Source stuff
//	between my workstation and Raspberry Pi.

//	Hacked together in less than 30mins, MIT license, Use at your own risk! ;-)
//	TODO: Fix stuff I was too lazy to code at 1am..

//	Files in the current directory gets overwritten, which could be an issue.
//	TODO: Archive changes in a git-repository.

var broadcastIP = '192.168.0.255',	// `ifconfig` can tell you what it is.
	port	= process.env['PORT']	|| 5142,
	uport	= process.env['UPORT']	|| 1337,
	root	= process.env['PRJROOT']|| '.';

var	os		= require('os'),
	fs		= require('fs'),
	url		= require('url'),
	http	= require('http'),
	path	= require('path'),
	dgram	= require('dgram'),
	spawn	= require('child_process').spawn;

var myName = os.hostname(),
	cooldowntime = 111,
	cooldown = false;

var nInterfaces = os.networkInterfaces(),
	udpSocket = null,
	servers = [],
	extIP = [];

//	Get external IP-adresses
for (var dev in nInterfaces) {
	nInterfaces[dev].forEach(function(details){
		if (details.family=='IPv4' && !details.internal) {
			extIP.push(details.address);
		}
	});
}

//	Create a http server on each one
extIP.forEach(function(IP){
	var server = http.createServer(function handeRequest( req, resp ) {
		var nodeName = root+req.url;

		fs.stat(nodeName, function checkFile( err, stats ) {
			if (err === null && stats.isFile() ) {
				streamFile(resp, nodeName);
			} else {
				if (err === null && stats.isDirectory()) {
					fileName = nodeName + 'index.html';
					fs.stat(fileName, function transferResponse( err, stats ) {
						if (err === null && stats.isFile() ) {
							streamFile(resp, fileName);
						} else {
							return lsd(resp, nodeName);
						}
					});
				} else {
					resp.writeHead(404);
					resp.end('File Not Found');
				};
			}
		});
	});
	server.listen(port, IP);
	console.log('Serving files on http://'+ IP +':'+ port +'/');
	servers.push(server);
});

udpSocket = dgram.createSocket("udp4");
udpSocket.on("message", function (msg, remote) {
	//	Ensure we don't talk to ourselves, cuz' that's insane! ;-)
	var self = (extIP.indexOf(remote.address)>-1)?true:false;
//	console.log("Recieved '"+ msg +"' from "+ ((self)?"our self":remote.address));
	if(!self && (msg+'').match(/nodesync\:\{([^$]*)\:([^$]*)\}/)) {
		msg = JSON.parse(msg.slice(9));
		var node = ''+msg["path"]+msg["fileName"];
		console.log("File incoming! ("+node+")");
		http.get("http://"+remote.address+":"+msg["port"]+node, function(res) {
			cooldown = true;
			setTimeout(function (){ cooldown = false; }, cooldowntime);
			console.log("Got response: " + res.statusCode);
			res.pipe(fs.createWriteStream(root+node));
		}).on('error', function(e) {
			console.log("Uh-oh (res.statusCode): " + e.message);
		});
	}
});

udpSocket.on("listening", function () {
	var addr = udpSocket.address();
	console.log("Listening for messages on udp://"+ addr.address +":"+ addr.port +"/");
	udpSocket.setBroadcast(true);
});

udpSocket.bind(uport);

//	This seems like the most realible way, all other seems to completely
//	miss newly created directories, which in this kind of use is fatal..
var fsw = spawn("inotifywait", ["--exclude",".git","-cqrme","modify,move",root]);
fsw.stdout.on('data', function (data) {
	if(cooldown) return; // hackish way to avoid file ping-pong
	//	since gedit & sublime does fun stuff w/ files, use a timebased filter..
	setTimeout(function () {
		var ev = (data+'').split(',');
		var fileName = ev[ev.length-1].trim(),
			path = ev[0];
		if(fs.existsSync(path+fileName)) {
			var stat = fs.statSync(path+fileName);
			if(stat.isFile(path+fileName)) {
				var message = new Buffer("nodesync:"+JSON.stringify({
					"path"		: path.replace(/^\./, ''),
					"fileName"	: fileName,
					"event"		: ev[1],
					"port"		: port
				}));
				udpSocket.send(message, 0, message.length, uport, broadcastIP, function(err, bytes) {
					if(err) gracefulShutdown(err);
				});
			}
		}
	}, 123);
});

process.nextTick(function(){
	var message = new Buffer("Hello!");
	udpSocket.send(message, 0, message.length, uport, broadcastIP, function(err, bytes) {
		if(err) gracefulShutdown(err);
	});
});

function gracefulShutdown(reason, code) {
	console.log(reason);
	udpSocket.close();
	servers.forEach(function(server){
		server.close();
	});
	process.exit(code||0);
}

//	Some good functions.
function streamFile( dest, fileName ) {
	var mimeType = getMime(fileName);
	var stream = fs.createReadStream(fileName);
	stream.on('error', function handleError() {
	//	dest.writeHead(500);
		dest.end('An error occured ;-(');
	});

	dest.writeHead(200, { 'Content-Type': mimeType });
	stream.pipe(dest);
}

//	LiSt Directory
function lsd( out, dir ) {
	fs.readdir(dir, function prettyDirectoryListing( err, files ) {
		if(err === null) {
			out.writeHead(300, { 'Content-Type': 'html' });
			out.write('<!DOCTYPE html5><html><head><meta charset="utf-8"/>'+
				'<title>Viewing '+dir+'</title></head><body><h1>Viewing '+
				dir+'</h1><table><th>file</th><th>mime</th><tr><td><a href'+
				'"=../">Parent Directory</a></td></tr>');
			for (var i = files.length - 1; i >= 0; i--) {
				var fsnode = dir+files[i];
				try {
					//	the first sin of node.js -- I know..
					stats = fs.statSync(dir+files[i]);
					var bs = path.basename(files[i]);
					if(stats.isDirectory()) bs += '/';
					out.write('<tr><td><a href="'+bs+'">'+bs+'</a></td>');
					if(stats.isDirectory()) {
						out.write('<td> [Directory Entry] </td></tr>');
					} else {
						out.write('<td>'+getMime(files[i])+'</td></tr>');
					}
				} catch( all ) {}
			}
			out.end('</table></body></html>');
		} else {
			out.writeHead(500);
			out.end('Uh, oh! Something bad happend, sorry! ;-C');
		}
	});
}

function getMime( file ) {
	//	TODO: make use of `file --mime-type -b file` or some better method.
	switch (path.extname(file)) {
		case '.css':
			return 'text/css';
		case '.htm':
		case '.html':
			return 'text/html'
		case '.js':
			return 'text/javascript';
		case '.json':
			return 'text/json';
		case '.md':
			return 'text/markdown';
		case '.sh':
			return 'text/plain';
		case '.yml':
			return 'text/yaml';
		default:
			return 'application/octet-stream'
	}
}
