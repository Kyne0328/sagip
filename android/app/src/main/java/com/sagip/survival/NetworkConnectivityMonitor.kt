package com.sagip.survival

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Monitors network availability via Android's ConnectivityManager.
 * When internet connectivity is detected (or re-established), invokes [onInternetAvailable].
 */
class NetworkConnectivityMonitor internal constructor(
    private val connectivityManager: ConnectivityManager?,
    private val onInternetAvailable: () -> Unit,
) {
    constructor(
        context: Context,
        onInternetAvailable: () -> Unit,
    ) : this(
        context.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager,
        onInternetAvailable,
    )

    private val listeningState = AtomicBoolean(false)
    private var networkCallback: ConnectivityManager.NetworkCallback? = null

    val isListening: Boolean
        get() = listeningState.get()

    internal fun handleNetworkAvailable() {
        onInternetAvailable()
    }

    internal fun handleCapabilitiesChanged(hasInternetCapability: Boolean) {
        if (hasInternetCapability) {
            onInternetAvailable()
        }
    }

    fun startListening() {
        if (listeningState.compareAndSet(false, true)) {
            val cm = connectivityManager ?: return
            try {
                val callback = object : ConnectivityManager.NetworkCallback() {
                    override fun onAvailable(network: Network) {
                        handleNetworkAvailable()
                    }

                    override fun onCapabilitiesChanged(network: Network, capabilities: NetworkCapabilities) {
                        handleCapabilitiesChanged(
                            capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET),
                        )
                    }
                }
                networkCallback = callback
                val request = NetworkRequest.Builder()
                    .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
                    .build()
                cm.registerNetworkCallback(request, callback)
            } catch (_: Exception) {
                // Best-effort; if network permissions or service are restricted, continue safely
            }
        }
    }

    fun stopListening() {
        if (listeningState.compareAndSet(true, false)) {
            val cm = connectivityManager ?: return
            val callback = networkCallback ?: return
            try {
                cm.unregisterNetworkCallback(callback)
            } catch (_: Exception) {
            } finally {
                networkCallback = null
            }
        }
    }

    fun isConnectedToInternet(): Boolean {
        return try {
            val activeNetwork = connectivityManager?.activeNetwork ?: return false
            val caps = connectivityManager.getNetworkCapabilities(activeNetwork) ?: return false
            caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
        } catch (_: Exception) {
            false
        }
    }
}
