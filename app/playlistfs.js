var libQ = require('kew');
var libFast = require('fast.js');
var libCrypto = require('crypto');
var libBase64Url = require('base64-url');
var libLevel = require('level');
var libUtil = require('util');
var libFs = require('fs');

// Define the CorePlaylistFS class
module.exports = CorePlaylistFS;
function CorePlaylistFS (commandRouter) {
	// This fixed variable will let us refer to 'this' object at deeper scopes
	var self = this;

	// Save a reference to the parent commandRouter
	self.commandRouter = commandRouter;

	self.playlists = {};
	self.playlistKeys = {};
	self.playlistRoot = [];

	// Attempt to load playlists from database on disk
	self.sPlaylistDBPath = './app/db/playlistfs';
	self.loadPlaylistsFromDB();
}

CorePlaylistFS.prototype.getRoot = function() {
	var self = this;
	self.commandRouter.pushConsoleMessage('[' + Date.now() + '] ' + 'CorePlaylistFS::getRoot');

	return libQ.resolve(self.playlistRoot);
}

CorePlaylistFS.prototype.getListing = function(sUid) {
	var self = this;
	self.commandRouter.pushConsoleMessage('[' + Date.now() + '] ' + 'CorePlaylistFS::getListing');

	return libQ.resolve(self.playlists[sUid].childindex);
}

// Load a LevelDB from disk containing the music library and indexes
CorePlaylistFS.prototype.loadPlaylistsFromDB = function() {
	var self = this;
	self.commandRouter.pushConsoleMessage('[' + Date.now() + '] ' + 'CorePlaylistFS::loadPlaylistsFromDB');
	self.commandRouter.pushConsoleMessage('Loading playlists from DB...');

	self.playlists = {};
	self.playlistKeys = {};
	self.playlistRoot = [];

	var dbPlaylists = libLevel(self.sPlaylistDBPath, {'valueEncoding': 'json', 'createIfMissing': true});
	return libQ.resolve()
		.then(function() {
			return libQ.nfcall(libFast.bind(dbPlaylists.get, dbPlaylists), 'playlists');
		})
		.then(function(result) {
			self.playlists = result;
			self.commandRouter.pushConsoleMessage('Playlists loaded from DB.');
			return libQ.nfcall(libFast.bind(dbPlaylists.get, dbPlaylists), 'keys');
		})
		.then(function(result) {
			self.playlistKeys = result;
			self.commandRouter.pushConsoleMessage('Keys loaded from DB.');
			return libQ.nfcall(libFast.bind(dbPlaylists.get, dbPlaylists), 'root');
		})
		.then(function(result) {
			self.playlistRoot = result;
			self.commandRouter.pushConsoleMessage('Root loaded from DB.');
		})
		.fail(function(sError) {
			throw new Error('Error reading DB: ' + sError);
		})
		.fin(libFast.bind(dbPlaylists.close, dbPlaylists));
}

CorePlaylistFS.prototype.dumpDB = function(sPath) {
	var self = this;

	var streamDbRead = libLevel(sPath).createReadStream({valueEncoding: 'json'});
	var streamFileWrite = libFs.createWriteStream(sPath + '.dump');

	streamDbRead.on('data', function(data) {
		streamFileWrite.write(data.key + ':\n' + libUtil.inspect(data.value, {depth: null}) + '\n\n');
	});

	streamDbRead.on('close', function() {
		streamFileWrite.close();
	});

	streamDbRead.on('end', function() {
		streamFileWrite.close();
	});

}

// Import existing playlists and folders from the various services
CorePlaylistFS.prototype.importServicePlaylists = function() {
	var self = this;
	self.commandRouter.pushConsoleMessage('[' + Date.now() + '] ' + 'CorePlaylistFS::importServicePlaylists');

	var dbPlaylists = libLevel(self.sPlaylistDBPath, {'valueEncoding': 'json', 'createIfMissing': true});
	return self.commandRouter.getAllTracklists()
		.then(function(arrayAllTracklists) {
			self.commandRouter.pushConsoleMessage('Importing playlists from music services...');

			return libQ.all(libFast.map(arrayAllTracklists, function(arrayTracklist) {
				return libQ.all(libFast.map([arrayTracklist[0], arrayTracklist[1], arrayTracklist[2]], function(curTrack) {
					return self.addPlaylistItem(curTrack);
				}));
			}));
		})
		.then(function() {
			return libQ.nfcall(libFast.bind(dbPlaylists.put, dbPlaylists), 'playlists', self.playlists);
		})
		.then(function() {
			return libQ.nfcall(libFast.bind(dbPlaylists.put, dbPlaylists), 'keys', self.playlistKeys);
		})
		.then(function() {
			return libQ.nfcall(libFast.bind(dbPlaylists.put, dbPlaylists), 'root', self.playlistRoot);
		})
		.then(function() {
			self.commandRouter.pushConsoleMessage('Playlists imported.');
		})
		.fin(libFast.bind(dbPlaylists.close, dbPlaylists));
}

// Add an track into the playlist filesystem
CorePlaylistFS.prototype.addPlaylistItem = function(curTrack) {
	var self = this;

	var arrayPath = curTrack.browsepath;
	var arrayCurFullPath = [];
	var curFolderKey = '';

	libFast.map(arrayPath, function(sCurPath, nIndex) {
		arrayCurFullPath = arrayCurFullPath.concat(sCurPath);

		curFolderKey = convertStringToHashkey(arrayCurFullPath.join('/'));
		if (!(curFolderKey in self.playlists)) {
			self.playlists[curFolderKey] = {
				'name': sCurPath,
				'type': 'folder',
				'uid': curFolderKey,
				'fullpath': arrayCurFullPath,
				'childindex': [],
				'childuids': {}
			};

			if (nIndex === 0) {
				self.playlistRoot.push({
					'name': sCurPath,
					'type': 'folder',
					'uid': curFolderKey
				});
			}
		}

		var arrayParentPath = arrayCurFullPath.slice(0, -1);
		if (arrayParentPath.length > 0) {
			var sParentKey = convertStringToHashkey(arrayParentPath.join('/'));
			if (!(curFolderKey in self.playlists[sParentKey].childuids)) {
				var objChildEntry = {
					'name': sCurPath,
					'type': 'folder',
					'uid': curFolderKey
				};

				self.playlists[sParentKey].childindex.push(objChildEntry);
				self.playlists[sParentKey].childuids[curFolderKey] = null;
			}
		}
	});

	var curTrackKey = convertStringToHashkey(curTrack.album + curTrack.name);
	self.playlists[curFolderKey].childindex.push({
		'name': curTrack.name,
		'type': 'item',
		'trackuid': 'track:' + curTrackKey,
		'service': curTrack.service,
		'uri': curTrack.uri,
		'duration': curTrack.duration
	});
	self.playlists[curFolderKey].childuids[curTrackKey] = null;

}

// Create a URL safe hashkey for a given string. The result will be a constant length string containing
// upper and lower case letters, numbers, '-', and '_'.
function convertStringToHashkey(input) {
    if (input === null) {
        input = '';

    }

	return libBase64Url.escape(libCrypto.createHash('sha256').update(input, 'utf8').digest('base64'));
}

