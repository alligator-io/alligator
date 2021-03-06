
const { api, _ } = require("../../")
const ms = require('ms')
const util = require('icebreaker-network/lib/util')

api.config.pingInterval = api.config.pingInterval || ms('15s')
const Intervals = require("../../lib/intervals")

module.exports = () => {
  const events = _.events()
  const end = events.end
  const timers = new Intervals()
  
  events.end = (err) => {
    timers.stopAll()
    end(err)
  }
  
  function isCloser(id, cb) {
    const closer = api.dht.findNode(api.id).map((item) => item.id).indexOf(id) !== -1
    if(!api.friends || !api.friends.isFriend) return cb(null,closer)
    api.friends.isFriend(id, (err, isFriend) => cb(err, isFriend && closer))
  }
  
  api.dht.ping = function ping(e, cb) {
    
    if (api.shutdown === true) return cb(new Error("'peer cannot ping " + e.peerID + ", because it is shutting down'"));
    
    api.log.debug('ping peer', e.peerID, "on", api.id)
    if (!e.peer.protoNames) return cb(new Error("peer.protoNames not found"))
    
    e.peer.protoNames((err, protos) => {
      api.log.debug('pinged peer ', e.peerID, "on", api.id)
      
      if (err || !Array.isArray(protos)) return cb(err || new Error("result of protoNames is not a array"))
      
      if (protos.length == 0) return cb(new Error("peer " + e.peerID + "listening on no protocols"))
      if ((e.address != null || e.remoteAddress != null)) {
        let address = e.address || e.remoteAddress
        const u = util.parseUrl(address)
        delete u.host
        
        const addr = protos.map((proto) => address.replace(e.protocol, proto.name).replace(u.port, proto.port))
        
        return _(
          addr,
          _.unique(),
          _.collect((err, addrs) => {

            if (err) return cb(err)

            const lastSeen = new Date().getTime();
            api.dht.bucket.add({ id: util.decode(e.peerID, api.config.encoding), addrs: addrs, lastSeen: lastSeen })

            isCloser(e.peerID, (err, closer) => {
              if (closer && e.isCloser != true) {
                e.isCloser = true
                events.emit({ type: 'closer', id: e.id, peerID: e.peerID, addrs: addrs, address: e.address, peer: e.peer, lastSeen: lastSeen })
              }

              if (!closer && e.isCloser != false) {
                e.isCloser = false
                events.emit({ type: 'notcloser', id: e.id, peerID: e.peerID, addrs: addrs, address: e.address, peer: e.peer, lastSeen: lastSeen })
              }

              return cb()

            })

          }))
      }

      return cb(new Error("error no address"))
    })
  }

  _(
    api.events(),
    api.events.on({

      connection: (e) => {
        if(!e.peerID) return;
        if (e.protocol.indexOf("+unix") !== -1) return

        api.dht.ping(e, (err) => {
          if (err) return;
          if (e.peer)
            timers.start(e.id, () => {
              isCloser(e.peerID, (err, closer) => {
                if (!closer) {
                  if (e.isCloser != false) {
                    e.isCloser = false
                    events.emit({ type: 'notcloser', address: e.address, id: e.id, peerID: e.peerID })
                  }

                  if (api.dht.bucket.count() < api.config.bucketSize && api.dht.get(e.peerID) == null) api.dht.ping(e, (err) => { })
                  return
                }
                api.dht.ping(e, (err) => { })
              })
            }, api.config.pingInterval)
        })

        const end = e.end
        e.end = () => {
          if (e.peerID) api.dht.bucket.remove(util.decode(e.peerID, api.config.encoding))
          timers.stop(e.id)
          end()
        }

      },

      disconnection: (e) => {
        if(!e.peerID) return;

        timers.stop(e.id)

        if (e.peerID) api.dht.bucket.remove(util.decode(e.peerID, api.config.encoding))

        isCloser(e.peerID, (err, closer) => {
          if (!closer && e.isCloser != false) {
            e.isCloser = false
            events.emit({ type: 'notcloser', id: e.id, address: e.address, peerID: e.peerID })
          }
        })

      },

      end: () => timers.stopAll()

    }))

  events.emit({ type: "ready" })

  return events
}
