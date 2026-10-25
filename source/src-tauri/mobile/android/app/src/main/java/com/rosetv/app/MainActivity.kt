package com.rosetv.app

import android.os.Build
import android.os.Bundle
import android.view.View
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)

    // Enable edge-to-edge display
    WindowCompat.setDecorFitsSystemWindows(window, false)

    val controller = WindowInsetsControllerCompat(window, window.decorView)
    
    // Hide the system bars (status bar and navigation bar)
    controller.hide(WindowInsetsCompat.Type.systemBars())
    
    // Set the behavior for when system bars are shown (e.g., by swiping from an edge)
    // BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE makes them overlay content and automatically hide again.
    controller.systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
  }
}
