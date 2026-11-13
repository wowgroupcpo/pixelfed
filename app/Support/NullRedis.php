<?php

namespace App\Support;

/**
 * In-memory stand-in for a phpredis/predis connection, used when the
 * application is told there is no Redis to talk to.
 *
 * Pixelfed uses Redis as an *index* over Postgres: timeline sorted sets,
 * story indexes, follower sets, notification sets. Every one of those has a
 * database-backed fallback path already (that is why the test suite can run
 * with `Redis::spy()`), but the code calls the facade directly, so without a
 * connection the call itself throws before any fallback is reached.
 *
 * This object answers every read as "the index is empty" and swallows every
 * write. Queries then take their existing cold/database path instead of
 * failing, which is the correct behaviour on a host that has no Redis.
 *
 * It is deliberately forgiving: an unknown method is a no-op that returns a
 * neutral value, so a future Redis call cannot turn into a 500 here.
 */
class NullRedis
{
    /**
     * Method names whose empty result is a boolean rather than an int.
     */
    private const BOOLEAN_COMMANDS = [
        'exists', 'hexists', 'sismember', 'setnx', 'expire', 'expireat',
        'persist', 'rename', 'renamenx', 'set', 'msetnx', 'hsetnx',
        'zadd', 'zrem', 'sadd', 'srem', 'hset', 'lpush', 'rpush', 'lrem',
        'incr', 'decr', 'hincrby', 'zincrby', 'del', 'unlink', 'flushdb',
        'flushall', 'select', 'auth', 'ping', 'publish',
    ];

    /**
     * Method names that return a scalar/string or null.
     */
    private const SCALAR_COMMANDS = [
        'get', 'hget', 'zscore', 'zcard', 'scard', 'llen', 'incr', 'decr',
        'hincrby', 'zincrby', 'ttl', 'pttl', 'zrevrank', 'zrank', 'strlen',
    ];

    public function __call($method, $arguments)
    {
        return $this->respond(strtolower($method));
    }

    /**
     * Facade calls are proxied here, so the common commands are also declared
     * explicitly for static analysis and readability.
     */
    public function ping(): bool
    {
        return false;
    }

    public function connection($name = null)
    {
        return $this;
    }

    public function client()
    {
        return $this;
    }

    public function pipeline(callable $callback)
    {
        // A pipeline is a batch of writes. Hand the caller this same sink so
        // the callback's commands are swallowed, then report no results.
        $callback($this);

        return [];
    }

    public function transaction(callable $callback)
    {
        return $this->pipeline($callback);
    }

    public function multi()
    {
        return $this;
    }

    public function exec()
    {
        return [];
    }

    private function respond(string $method)
    {
        if (in_array($method, self::BOOLEAN_COMMANDS, true)) {
            return false;
        }

        if (in_array($method, self::SCALAR_COMMANDS, true)) {
            return null;
        }

        // Sorted-set / set / list / hash reads all expect an array.
        return [];
    }
}
